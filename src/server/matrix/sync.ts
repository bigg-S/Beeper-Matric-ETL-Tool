import * as MatrixSDK from 'matrix-js-sdk';
import { supabase } from '../db/client';
import { SyncStatus } from '../../types';
import { cryptoManager } from './crypto';

export class SyncManager {
private client: MatrixSDK.MatrixClient;
private syncState: SyncStatus = {
    state: 'initializing',
    progress: 0,
};

constructor(client: MatrixSDK.MatrixClient) {
    this.client = client;
}

async startSync() {
    try {
        this.setupSyncListeners();
        await this.client.startClient({ initialSyncLimit: 30 });
    } catch (error: any) {
        await this.updateSyncStatus('error', error.message);
        throw error;
    }
}

private setupSyncListeners() {
    this.client.on('sync', async (state: string, prevState?: string, data?: any) => {
        await this.handleSyncStateChange(state, data);
    });

    this.client.on('Room.timeline', async (event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room) => {
        await this.handleTimelineEvent(event, room);
    });

    this.client.on('Room.receipt', async (event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room) => {
        await this.handleReceiptEvent(event, room);
    });
}

private async handleSyncStateChange(state: string, data?: any) {
    let progress = this.syncState.progress;

    switch (state) {
        case 'PREPARING':
        progress = 0.1;
        break;
        case 'SYNCING':
        progress = 1;
        break;
        case 'ERROR':
        await this.updateSyncStatus('error', data?.error?.message);
        return;
    }

    await this.updateSyncStatus(state.toLowerCase(), undefined, progress);
}

private async handleTimelineEvent(event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room) {
    try {
        if (event.isEncrypted()) {
        const decryptedEvent = await cryptoManager.decryptEvent(event);
        event = decryptedEvent;
    }

        if (event.getType() === 'm.room.message') {
        await this.storeMessage(event, room);
    }
    } catch (error: any) {
        console.error(`Failed to process timeline event: ${error.message}`);
    }
}

private async handleReceiptEvent(event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room) {
    /// read  receipt
}

private async storeMessage(event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room) {
    const messageData = {
        id: event.getId(),
        room_id: room.roomId,
        sender: event.getSender(),
        content: event.getContent().body,
        timestamp: event.getDate()?.toISOString(),
        encrypted: event.isEncrypted(),
        event_type: event.getType(),
    };

    const { error } = await supabase
        .from('messages')
        .upsert(messageData, { onConflict: 'id' });

    if (error) {
        console.error(`Failed to store message: ${error.message}`);
    }
}

private async updateSyncStatus(
    state: string,
    error?: string,
    progress?: number
) {
    this.syncState = {
        state: state as SyncStatus['state'],
        progress,
        lastSync: new Date(),
        error,
    };

    await supabase.from('sync_status').upsert({
        state: this.syncState.state,
        progress: this.syncState.progress,
        last_sync: this.syncState.lastSync?.toISOString(),
        error: this.syncState.error,
    });
}

public getSyncState(): SyncStatus {
        return this.syncState;
    }
}
