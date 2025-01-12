import * as MatrixSDK from 'matrix-js-sdk';
import { supabase } from '../db/client';
import { MessageQueue, ParticipantData, RoomData, SyncProgress, SyncStatus } from '../../types';
import { cryptoManager } from './crypto';

export class SyncManager {
    private client: MatrixSDK.MatrixClient;
    private syncState: SyncStatus = {
        state: 'initializing',
        progress: 0,
        lastSync: undefined,
        error: undefined
    };
    private messageQueue: MessageQueue;
    private syncProgress: SyncProgress = {
        totalRooms: 0,
        processedRooms: 0,
        totalMessages: 0,
        processedMessages: 0,
        lastMessageTimestamp: null
    };
    private readonly BATCH_SIZE = 50;
    private processingQueue: boolean = false;

    constructor(client: MatrixSDK.MatrixClient) {
        this.client = client;
        this.messageQueue = new MessageQueue(this.BATCH_SIZE);
    }

    async startSync(options: { fullSync?: boolean } = {}) {
        try {
            const lastSync = await this.getLastSyncTimestamp();

            if (options.fullSync || !lastSync) {
                await this.performFullSync();
            } else {
                await this.performIncrementalSync(lastSync);
            }

            this.setupSyncListeners();
            await this.client.startClient({ initialSyncLimit: 30 });
            this.startMessageQueueProcessor();
        } catch (error: any) {
            await this.updateSyncStatus('error', error.message);
            throw error;
        }
    }

    private async performFullSync() {
        await this.updateSyncStatus('full_sync', undefined, 0.1);

        // First sync all rooms and participants
        const rooms = this.client.getRooms();
        this.syncProgress.totalRooms = rooms.length;

        for (const room of rooms) {
            await this.syncRoom(room);
            await this.syncParticipants(room);
            this.syncProgress.processedRooms++;
            await this.updateSyncProgress();
        }

        // Then sync messages
        await this.syncHistoricalMessages();
    }

    private async syncRoom(room: MatrixSDK.Room) {
        const roomData: RoomData = {
            id: room.roomId,
            name: room.name,
            topic: room.currentState.getStateEvents('m.room.topic')[0]?.getContent().topic,
            is_encrypted: room.currentState.isEncrypted(),
            created_ts: room.getCreationTs(),
            avatar_url: room.currentState.getStateEvents('m.room.avatar')[0]?.getContent().url,
            last_updated: new Date().toISOString()
        };

        const { error } = await supabase
            .from('rooms')
            .upsert(roomData, { onConflict: 'id' });

        if (error) throw new Error(`Failed to sync room: ${error.message}`);
    }

    private async syncParticipants(room: MatrixSDK.Room) {
        const members = await room.getJoinedMembers();

        for (const member of members) {
            const participantData: ParticipantData = {
                user_id: member.userId,
                display_name: member.name,
                avatar_url: member.getMxcAvatarUrl(),
                membership: member.membership,
                room_id: room.roomId,
                joined_ts: member.events.member?.getTs(),
                last_updated: new Date().toISOString()
            };

            const { error } = await supabase
                .from('participants')
                .upsert(participantData, { onConflict: 'user_id, room_id' });

            if (error) throw new Error(`Failed to sync participant: ${error.message}`);
        }
    }

    private async syncHistoricalMessages(limit: number = 1000) {
        for (const room of this.client.getRooms()) {
            let token = null;
            let messageCount = 0;

            while (messageCount < limit) {
                const timeline = await this.client.scrollback(room, this.BATCH_SIZE, token);
                if (!timeline || timeline.length === 0) break;

                for (const event of timeline) {
                    await this.processEvent(event, room);
                    messageCount++;
                    this.syncProgress.totalMessages++;
                }

                token = timeline[timeline.length - 1].getId();
                await this.updateSyncProgress();
            }
        }
    }

    private async processEvent(event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room) {
        try {
            if (event.isEncrypted()) {
                const decrypted = await cryptoManager.decryptEvent(event);
                if (decrypted) {
                    await this.messageQueue.enqueue({
                        event: decrypted,
                        room,
                        type: 'message'
                    });
                }
            } else {
                await this.messageQueue.enqueue({
                    event,
                    room,
                    type: 'message'
                });
            }

            this.syncProgress.processedMessages++;
        } catch (error: any) {
            console.error(`Failed to process event: ${error.message}`);
            await this.messageQueue.enqueue({
                event,
                room,
                type: 'error',
                error: error.message
            });
        }
    }

    private async startMessageQueueProcessor() {
        if (this.processingQueue) return;
        this.processingQueue = true;

        while (this.processingQueue) {
            const batch = await this.messageQueue.dequeue(this.BATCH_SIZE);
            if (batch.length === 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            await this.processBatch(batch);
        }
    }

    private async processBatch(batch: any[]) {
        const messages = batch.map(item => ({
            id: item.event.getId(),
            room_id: item.room.roomId,
            sender: item.event.getSender(),
            content: item.event.getContent(),
            timestamp: item.event.getDate()?.toISOString(),
            encrypted: item.event.isEncrypted(),
            event_type: item.event.getType(),
            error: item.type === 'error' ? item.error : null
        }));

        const { error } = await supabase
            .from('messages')
            .upsert(messages, { onConflict: 'id' });

        if (error) {
            console.error(`Failed to store message batch: ${error.message}`);
            // requeue failed messages with exponential backoff
            await this.messageQueue.requeue(batch);
        }
    }

    private async performIncrementalSync(lastSync: string) {
        await this.updateSyncStatus('incremental_sync', undefined, 0.1);
        const syncToken = await this.client.getSyncToken();

        if (syncToken) {
            await this.client.sync({
                since: syncToken,
                filter: {
                    room: {
                        timeline: {
                            limit: 50
                        }
                    }
                }
            });
        }
    }

    private async getLastSyncTimestamp(): Promise<string | null> {
        const { data, error } = await supabase
            .from('sync_status')
            .select('last_sync')
            .order('last_sync', { ascending: false })
            .limit(1);

        if (error || !data.length) return null;
        return data[0]?.last_sync;
    }

    private async updateSyncProgress() {
        const progress = (
            (this.syncProgress.processedRooms / Math.max(1, this.syncProgress.totalRooms)) * 0.3 +
            (this.syncProgress.processedMessages / Math.max(1, this.syncProgress.totalMessages)) * 0.7
        );

        await this.updateSyncStatus(this.syncState.state, undefined, progress);
    }

    async stopSync() {
        try {
            this.client.stopClient();
            this.cleanupSyncListeners();
            await this.updateSyncStatus('stopped', undefined, 0);
            console.log('Sync process stopped.');
        } catch (error: any) {
            console.error(`Failed to stop sync: ${error.message}`);
            throw error;
        }
    }

    private setupSyncListeners() {
        this.client.on(MatrixSDK.ClientEvent.Sync, async (state: string, prevState?: string, data?: any) => {
            await this.handleSyncStateChange(state, data);
        });

        this.client.on(MatrixSDK.ClientEvent.Room, async (event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room) => {
            await this.processEvent(event, room);
        });

    }

    private cleanupSyncListeners() {
        this.client.removeAllListeners(MatrixSDK.ClientEvent.Sync);
        this.client.removeAllListeners(MatrixSDK.ClientEvent.Room);
        console.log('Sync listeners cleaned up.');
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

    async getSyncStatus(): Promise<{
        syncState: SyncStatus;
        progress: SyncProgress;
        queueStatus: {
            pending: number;
            processing: number;
            failed: number;
        };
    }> {
        const queueStatus = await this.messageQueue.getStatus();

        return {
            syncState: this.syncState,
            progress: this.syncProgress,
            queueStatus
        };
    }

}
