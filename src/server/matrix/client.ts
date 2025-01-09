import * as sdk from 'matrix-js-sdk';
import { MatrixConfig } from '../../types';
import { initCrypto } from './crypto';
import { supabase } from '../db/client';

export class MatrixClient {
private client: sdk.MatrixClient;
private config: MatrixConfig;

constructor(config: MatrixConfig) {
    this.config = config;
    this.client = sdk.createClient({
        baseUrl: `https://${config.domain}`,
        userId: `@${config.username}:${config.domain}`,
    });
}

async initialize() {
    await this.login();
    await initCrypto(this.client);
    await this.startSync();
}

private async login() {
    try {
        await this.client.login('m.login.password', {
            user: this.config.username,
            password: this.config.password,
        });
    } catch (error) {
        throw new Error(`Failed to login: ${error.message}`);
    }
}

private async startSync() {
    this.client.on('sync', async (state: string) => {
        await supabase.from('sync_status').upsert({
        state,
        last_sync: new Date().toISOString(),
        });
    });

    this.client.on('Room', async (room: sdk.Room) => {
        await this.processRoom(room);
    });

    this.client.on('Event', async (event: sdk.MatrixEvent) => {
        await this.processEvent(event);
    });

    await this.client.startClient({ initialSyncLimit: 10 });
}

private async processRoom(room: sdk.Room) {
    const roomData = {
        id: room.roomId,
        name: room.name,
        topic: room.currentState.getStateEvents('m.room.topic')?.[0]?.getContent().topic,
        encrypted: room.currentState.getStateEvents('m.room.encryption').length > 0,
        members: Array.from(room.getJoinedMembers().map(m => m.userId)),
    };

    await supabase.from('rooms').upsert(roomData);
}

private async processEvent(event: sdk.MatrixEvent) {
    if (event.getType() !== 'm.room.message') return;

    const messageData = {
        id: event.getId(),
        room_id: event.getRoomId(),
        sender: event.getSender(),
        content: event.getContent().body,
        timestamp: event.getDate().toISOString(),
        encrypted: event.isEncrypted(),
    };

    await supabase.from('messages').upsert(messageData);
    }
}
