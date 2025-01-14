import * as MatrixSDK from 'matrix-js-sdk';
import { IMyDevice, MatrixEvent, PendingEventOrdering, Room } from 'matrix-js-sdk';
import { MatrixAuthConfig } from '../../types';
import { cryptoManager } from './crypto';
import { supabase } from '../db/client';
import { EventEmitter } from 'events';
import * as dotenv from 'dotenv';

dotenv.config();

export class MatrixClient extends EventEmitter {
    private client: MatrixSDK.MatrixClient;
    private authConfig: MatrixAuthConfig;
    private syncToken: string | null = null;

    constructor(authConfig: MatrixAuthConfig) {
        super();
        this.authConfig = authConfig;
        this.client = MatrixSDK.createClient({
            pickleKey: process.env.PICKLE_KEY,
            baseUrl: `https://${authConfig.domain}`,
            accessToken: process.env.MATRIX_ACCESS_TOKEN,
            userId: `@${authConfig.username}:${authConfig.domain}`,
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
                user: this.authConfig.username,
                password: this.authConfig.password,
            });

            await supabase.from('device_credentials').insert({
                user_id: this.client.getUserId(),
                device_id: loginResponse.device_id,
                access_token: loginResponse.access_token,
                refresh_token: loginResponse.refresh_token,
                expires_in_ms: loginResponse.expires_in_ms,
                well_known: loginResponse.well_known,
                created_at: new Date().toISOString(),
            });
        } catch (error: any) {
            throw new Error(`Failed to login: ${error.message}`);
        }
    }

    public async logout() {
        try {
            await this.client.logout();

            this.syncToken = null;

            const userId = this.client.getUserId();
            if (userId) {
                await supabase.from('device_credentials').delete().eq('user_id', userId);
            }

            this.client.stopClient();

            console.log('Successfully logged out');
        } catch (error: any) {
            console.error(`Failed to logout: ${error.message}`);
            throw new Error(`Logout failed: ${error.message}`);
        }
    }

    public async getUserProfile(userId: string) {
        try {
            const displayName = await this.client.getProfileInfo(userId, 'displayname');
            const avatarUrl = await this.client.getProfileInfo(userId, 'avatar_url');
            return {
                displayName: displayName?.displayname || null,
                avatarUrl: avatarUrl?.avatar_url || null,
            };
        } catch (error: any) {
            console.error(`Failed to fetch user profile for ${userId}:`, error);
            throw new Error(`Unable to fetch user profile: ${error.message}`);
        }
    }

    private async setupCrypto() {
        await cryptoManager.initCrypto(this.client);

        await this.client.initRustCrypto();

        const cryptoApi = this.client.getCrypto();
        if (cryptoApi) {
            const keyBackupInfo = await cryptoApi.getKeyBackupInfo();
            if (!keyBackupInfo) {
                await cryptoApi.checkKeyBackupAndEnable();
            }
        }

        this.client.getCrypto()?.bootstrapCrossSigning({
            authUploadDeviceSigningKeys: async (makeRequest) => {
                return makeRequest(this.authConfig).then(() => {});
            },
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
                await this.saveSyncToken();
            }
            await this.updateSyncStatus(state, data);
        });

        this.client.on(MatrixSDK.RoomEvent.Timeline, async (event) => {
            await this.processEvent(event);
        });

        await this.client.startClient({
            filter: filterDef,
            initialSyncLimit: 50,
            pendingEventOrdering: "chronological" as PendingEventOrdering,
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

    // private async processRoom(room: Room) {
    //     const timeline = room.getLiveTimeline();
    //     const state = timeline.getState(MatrixSDK.EventTimeline.FORWARDS);

    //     const roomData = {
    //         id: room.roomId,
    //         name: room.name,
    //         topic: state?.getStateEvents('m.room.topic')?.[0]?.getContent().topic,
    //         encrypted: state!.getStateEvents('m.room.encryption')?.length > 0,
    //         members: Array.from(room.getJoinedMembers().map((m) => m.userId)),
    //         created_at: new Date().toISOString(),
    //         last_updated: new Date().toISOString(),
    //     };

    //     await supabase.from('rooms').upsert(roomData, { onConflict: 'id' });
    // }

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

            await supabase.from('messages').upsert(messageData, { onConflict: 'id' });
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

    // private async handleDeviceVerification(userId: string, deviceId: string) {
    //     const device = await this.client.getDevice(deviceId) as IMyDevice;
    //     await supabase.from('device_verifications').insert({
    //         user_id: userId,
    //         device_id: deviceId,
    //         display_name: device.display_name,
    //         updated_at: new Date().toISOString(),
    //     });
    // }

    private async handleKeyBackupStatus(status: boolean) {
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
