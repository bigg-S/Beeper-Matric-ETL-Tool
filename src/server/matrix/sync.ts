import * as MatrixSDK from 'matrix-js-sdk';
import { supabase } from '../db/client';
import { ParticipantData, RoomData, SyncManagerOptions, SyncStatus } from '../../types';
import { cryptoManager } from './crypto';
import { MessageQueueImpl } from '@/types/message-queue';

export class SyncManager {
    private client: MatrixSDK.MatrixClient;
    private syncState: SyncStatus = {
        state: 'initializing',
        lastSync: undefined,
        error: undefined
    };
    private messageQueue: MessageQueueImpl;
    private readonly options: Required<SyncManagerOptions>;
    private processingQueue: boolean = false;

    constructor(
        client: MatrixSDK.MatrixClient,
        options: SyncManagerOptions = {}
    ) {
        this.client = client;
        this.options = {
            batchSize: options.batchSize || 10000,
            initialSyncLimit: options.initialSyncLimit || 30,
            timeoutMs: options.timeoutMs || 30000,
        };
        this.messageQueue = new MessageQueueImpl(this.options.batchSize);
    }

    async startSync(): Promise<void> {
        try {
            if (!cryptoManager.getStatus().initialized) {
                throw new Error('Crypto manager must be initialized before starting sync');
            }

            const rooms = this.client.getRooms();
            for (const room of rooms) {
                await this.syncRoom(room);
                await this.syncParticipants(room);
                await this.syncRoomMessages(room);
            }

            this.setupSyncListeners();
            await this.client.startClient({
                initialSyncLimit: this.options.initialSyncLimit,
                includeArchivedRooms: true
            });

            this.startMessageQueueProcessor();
        } catch (error: any) {
            await this.handleSyncError(error);
            throw error;
        }
    }

    private async syncRoom(room: MatrixSDK.Room) {
        const roomData: RoomData = {
            id: room.roomId,
            name: room.name,
            topic: room.getLiveTimeline()?.getState(MatrixSDK.EventTimeline.FORWARDS)?.getStateEvents('m.room.topic')[0]?.getContent()?.topic ?? "",
            is_encrypted: !!room.getLiveTimeline().getState(MatrixSDK.EventTimeline.FORWARDS)?.getStateEvents(MatrixSDK.EventType.RoomEncryption, ""),
            created_ts: room.getLiveTimeline().getState(MatrixSDK.EventTimeline.FORWARDS)?.getStateEvents('m.room.create', '')?.getTs(),
            avatar_url: room.getLiveTimeline()?.getState(MatrixSDK.EventTimeline.FORWARDS)?.getStateEvents('m.room.avatar')[0]?.getContent()?.url ?? "",
            last_updated: new Date().toISOString(),
        };

        const { error } = await supabase
            .from('rooms')
            .upsert(roomData, { onConflict: 'id' });

        if (error) throw new Error(`Failed to sync room: ${error.message}`);
    }

    private async syncParticipants(room: MatrixSDK.Room) {
        const members = room.getJoinedMembers();

        for (const member of members) {
            const participantData: ParticipantData = {
                user_id: member.userId,
                display_name: member.name,
                avatar_url: member.getMxcAvatarUrl(),
                membership: member.membership ?? "",
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

    private async syncRoomMessages(room: MatrixSDK.Room): Promise<void> {
        let endReached = false;

        while (!endReached) {
            try {
                const timeline = await this.client.scrollback(room, this.options.batchSize);

                if (!timeline || timeline.getLiveTimeline().getEvents().length < this.options.batchSize) {
                    endReached = true;
                }

                for (const event of timeline.getLiveTimeline().getEvents()) {
                    await this.processEvent(event, room);
                }

                // Let the SDK handle rate limiting naturally
                await new Promise(resolve => setTimeout(resolve, 100));

            } catch (error: any) {
                console.error(`Error during message sync: ${error.message}`);
                break;
            }
        }
    }

    private async processEvent(event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room): Promise<void> {
        try {
            let content = event.getContent();

            if (event.isEncrypted()) {
                const decrypted = await cryptoManager.decryptEvent(event);
                if (decrypted) {
                    content = decrypted;
                } else {
                    throw new Error('Failed to decrypt event');
                }
            }

            await this.messageQueue.enqueue({
                event: {
                    ...event,
                    content,
                    decrypted: event.isEncrypted()
                },
                room,
                type: 'message'
            });

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
            const batch = await this.messageQueue.dequeue(this.options.batchSize);
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
            content: item.event.content,
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
            // Simple retry mechanism
            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.messageQueue.requeue(batch);
        }
    }

    private async handleSyncError(error: Error): Promise<void> {
        const errorMessage = error.message;
        await this.updateSyncStatus('error', errorMessage);

        if (errorMessage.includes('decrypt') || errorMessage.includes('crypto')) {
            try {
                await cryptoManager.recoverKeys();
            } catch (recoveryError: any) {
                console.error('Failed to recover keys:', recoveryError);
            }
        }
    }

    private async updateSyncStatus(
        state: string,
        error?: string
    ) {
        this.syncState = {
            state: state as SyncStatus['state'],
            lastSync: new Date(),
            error,
        };

        await supabase.from('sync_status').upsert({
            state: this.syncState.state,
            last_sync: this.syncState.lastSync?.toISOString(),
            error: this.syncState.error,
        });
    }

    private setupSyncListeners() {
        // Sync event listener
        this.client.on(MatrixSDK.ClientEvent.Sync, async (
            state: MatrixSDK.SyncState,
            _prevState: MatrixSDK.SyncState | null,
            data?: MatrixSDK.SyncStateData
        ) => {
            if (state === 'ERROR') {
                await this.updateSyncStatus('error', data?.error?.message);
            } else {
                await this.updateSyncStatus(state.toLowerCase());
            }
        });

        this.client.on(MatrixSDK.ClientEvent.Event, function (event) {
            console.log(event.getType());
        });

        // Room event listener
        // this.client.on("Room", (room: MatrixSDK.Room) => {
        //     // Get the latest event from the room
        //     const timeline = room.getLiveTimeline();
        //     const events = timeline.getEvents();
        //     if (events.length > 0) {
        //         const latestEvent = events[events.length - 1];
        //         if(latestEvent) {
        //             this.processEvent(latestEvent, room).catch(error => {
        //                 console.error('Failed to process room event:', error);
        //             });
        //         }

        //     }
        // });

        // this.client.on(MatrixSDK.RoomEvent.Name, (room: MatrixSDK.Room) => {
        //     console.log(`Room name changed to: ${room.name}`);
        //     // Handle room name changes here (e.g., update UI)
        //   });

        //   // Listener for member events (join, leave, ban, etc.)
        //   this.client.on(MatrixSDK.RoomEvent.Member, (event: MatrixSDK.MatrixEvent, member: any) => {
        //     console.log(`Member event for ${member.userId}: ${member.membership}`);
        //     // Handle member events here (e.g., update member list)
        //   });

        // Room.timeline listener for real-time events
        this.client.on(MatrixSDK.RoomEvent.Timeline, (
            event: MatrixSDK.MatrixEvent,
            room: MatrixSDK.Room | undefined,
            toStartOfTimeline: boolean | undefined
        ) => {
            if (!toStartOfTimeline && room) {
                this.processEvent(event, room).catch(error => {
                    console.error('Failed to process timeline event:', error);
                });
            }
        });
    }

    async stopSync() {
        try {
            this.client.stopClient();
            this.client.removeAllListeners(MatrixSDK.ClientEvent.Sync);
            this.client.removeAllListeners(MatrixSDK.ClientEvent.Room);
            this.processingQueue = false;
            await this.updateSyncStatus('stopped');
        } catch (error: any) {
            console.error(`Failed to stop sync: ${error.message}`);
            throw error;
        }
    }

    async getSyncStatus(): Promise<{
        syncState: SyncStatus;
        queueStatus: {
            pending: number;
            processing: number;
            failed: number;
        };
        cryptoStatus: {
            initialized: boolean;
            totalKeys: number;
            backedUpKeys: number;
        };
    }> {
        const queueStatus = await this.messageQueue.getStatus();
        const cryptoStatus = cryptoManager.getStatus();

        return {
            syncState: this.syncState,
            queueStatus,
            cryptoStatus: {
                initialized: cryptoStatus.initialized,
                totalKeys: cryptoStatus.keysStatus.totalKeys,
                backedUpKeys: cryptoStatus.keysStatus.backedUpKeys
            }
        };
    }
}
