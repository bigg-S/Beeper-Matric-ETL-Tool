import * as MatrixSDK from 'matrix-js-sdk';
import { IMyDevice, MatrixEvent, PendingEventOrdering, Room } from 'matrix-js-sdk';
import { MatrixConfig } from '../../types';
import { cryptoManager } from './crypto';
import { supabase } from '../db/client';
import { EventEmitter } from 'events';

export class MatrixClient extends EventEmitter {
    private client: MatrixSDK.MatrixClient;
    private config: MatrixConfig;
    private syncToken: string | null = null;

    constructor(config: MatrixConfig) {
        super();
        this.config = config;
        this.client = MatrixSDK.createClient({
            baseUrl: `https://${config.domain}`,
            userId: `@${config.username}:${config.domain}`,
        });
    }

    async initialize() {
        await this.login();
        await this.setupCrypto();
        await this.loadSyncToken();
        await this.startSync();
    }

    private async login() {
        try {
            const loginResponse = await this.client.login('m.login.password', {
                user: this.config.username,
                password: this.config.password,
            });

            await supabase.from('device_credentials').insert({
                user_id: this.client.getUserId(),
                device_id: loginResponse.device_id,
                access_token: loginResponse.access_token,
                created_at: new Date().toISOString(),
            });
        } catch (error: any) {
            throw new Error(`Failed to login: ${error.message}`);
        }
    }

    private async setupCrypto() {
        await cryptoManager.initCrypto(this.client);

        const cryptoApi = this.client.getCrypto();
        if (cryptoApi) {
            const keyBackupInfo = await cryptoApi.getKeyBackupInfo();
            if (!keyBackupInfo) {
                await this.client.enableKeyBackup();
            }
        }

        this.client.on(MatrixSDK.ClientEvent.DeviceVerificationChanged, async (userId: string, deviceId: string) => {
            await this.handleDeviceVerification(userId, deviceId);
        });

        this.client.on(MatrixSDK.Crypto.CryptoEvent.KeyBackupStatus, async (status) => {
            await this.handleKeyBackupStatus(status);
        });
    }

    private async loadSyncToken() {
        const { data } = await supabase
            .from('sync_status')
            .select('next_batch')
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        this.syncToken = data?.next_batch || null;
    }

    private async startSync() {
        const filterDef = new MatrixSDK.Filter(this.client.getUserId()!);
        filterDef.setTimelineLimit(50);
        filterDef.setDefinition({
            room: {
                timeline: {
                    limit: 50,
                    types: ['m.room.message', 'm.room.encrypted'],
                },
            },
        });

        this.client.on(MatrixSDK.ClientEvent.Sync, async (state, _, data) => {
            if (state === 'PREPARED' || state === 'SYNCING') {
                this.syncToken = data.nextBatch;
                await this.saveSyncToken();
            }
            await this.updateSyncStatus(state, data);
        });

        this.client.on(MatrixSDK.RoomEvent.Timeline, async (event, room) => {
            await this.processEvent(event);
        });

        await this.client.startClient({
            filter: filterDef,
            initialSyncLimit: 50,
            pendingEventOrdering: "chronological" as PendingEventOrdering,
            syncToken: this.syncToken,
        });
    }

    private async saveSyncToken() {
        if (this.syncToken) {
            await supabase.from('sync_status').insert({
                next_batch: this.syncToken,
                created_at: new Date().toISOString(),
            });
        }
    }

    private async processRoom(room: Room) {
        const roomData = {
            id: room.roomId,
            name: room.name,
            topic: room.currentState.getStateEvents('m.room.topic')?.[0]?.getContent().topic,
            encrypted: room.currentState.getStateEvents('m.room.encryption').length > 0,
            members: Array.from(room.getJoinedMembers().map((m) => m.userId)),
            created_at: new Date().toISOString(),
            last_updated: new Date().toISOString(),
        };

        await supabase.from('rooms').insert(roomData, { onConflict: 'id' });
    }

    private async processEvent(event: MatrixEvent) {
        if (event.getType() !== 'm.room.message') return;

        try {
            let content = event.getContent();

            if (event.isEncrypted()) {
                const decryptedEvent = await cryptoManager.decryptEvent(event);
                content = decryptedEvent.getContent();
            }

            const messageData = {
                id: event.getId(),
                room_id: event.getRoomId(),
                sender: event.getSender(),
                content: content.body,
                msgtype: content.msgtype,
                timestamp: event.getDate()?.toISOString(),
                encrypted: event.isEncrypted(),
                edited: false,
                deleted: false,
                created_at: new Date().toISOString(),
            };

            await supabase.from('messages').insert(messageData, { onConflict: 'id' });
        } catch (error: any) {
            console.error(`Failed to process event ${event.getId()}:`, error);
            await supabase.from('failed_events').insert({
                event_id: event.getId(),
                room_id: event.getRoomId(),
                error: error.message,
                retry_count: 0,
                created_at: new Date().toISOString(),
            });
        }
    }

    private async handleDeviceVerification(userId: string, deviceId: string) {
        const device = await this.client.getDevice(deviceId) as IMyDevice;
        await supabase.from('device_verifications').insert({
            user_id: userId,
            device_id: deviceId,
            trust_level: device.trustLevel?.crossSigningVerified ? 'verified' : 'unverified',
            updated_at: new Date().toISOString(),
        });
    }

    private async handleKeyBackupStatus(status: string) {
        await supabase.from('key_backup_status').insert({
            status,
            created_at: new Date().toISOString(),
        });
    }

    private async updateSyncStatus(state: string, data: any) {
        await supabase.from('sync_status').insert({
            state,
            next_batch: data?.nextBatch,
            created_at: new Date().toISOString(),
        });
    }

    public getClient() {
        return this.client;
    }
}
