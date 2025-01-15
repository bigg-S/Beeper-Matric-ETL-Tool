import * as MatrixSDK from 'matrix-js-sdk';
import { supabase } from '../db/client';
import { RoomData, SyncManagerOptions, SyncStatus } from '../../types';
import { cryptoManager } from './crypto';
import { MessageQueueImpl } from '@/types/message-queue';
import { ISyncStateData, SyncApi, SyncApiOptions } from 'matrix-js-sdk/lib/sync';

export class SyncManager {
    private client: MatrixSDK.MatrixClient;
    private syncApi: SyncApi;
    private syncAccumulator: MatrixSDK.SyncAccumulator;
    private syncState: SyncStatus = {
        state: 'initializing',
        lastSync: undefined,
        error: undefined
    };
    private messageQueue: MessageQueueImpl;
    private readonly options: Required<SyncManagerOptions>;
    private processingQueue: boolean = false;
    private lastSyncToken: string | null = null;

    constructor(
        client: MatrixSDK.MatrixClient,
        options: SyncManagerOptions
    ) {
        this.client = client;
        this.options = {
            batchSize: options.batchSize || 1000,
            initialSyncLimit: options.initialSyncLimit || 30,
            timeoutMs: options.timeoutMs || 30000,
            maxTimelineEntries: options.maxTimelineEntries || 50
        };

        // Initialize SyncAccumulator with max timeline entries
        this.syncAccumulator = new MatrixSDK.SyncAccumulator({
            maxTimelineEntries: this.options.maxTimelineEntries
        });

        const storedClientOpts: MatrixSDK.IStoredClientOpts = {};
        const syncOpts: SyncApiOptions = {
            cryptoCallbacks: {
                onSyncCompleted: async () => {
                    await this.processPendingEvents();
                },
                onRoomKeyReceived: async () => {
                    await this.handleRoomKeyUpdate(); // TODO: custom callback
                }
            },
            canResetEntireTimeline: (roomId: string) => {
                // Only allow timeline reset if we've fully processed the room
                return this.isRoomFullySynced(roomId);
            }
        };

        this.syncApi = new SyncApi(client, storedClientOpts, syncOpts);

        this.messageQueue = new MessageQueueImpl(this.options.batchSize);
    }

    private async loadSavedSync(): Promise<string | null> {
        try {
            const { data, error } = await supabase
                .from('sync_state')
                .select('next_batch')
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (error) throw error;
            return data?.next_batch || null;
        } catch (error) {
            console.warn('Failed to load saved sync token:', error);
            return null;
        }
    }

    private async saveSyncToken(token: string): Promise<void> {
        try {
            await supabase
                .from('sync_state')
                .upsert({
                    next_batch: token,
                    created_at: new Date().toISOString()
                });
        } catch (error) {
            console.error('Failed to save sync token:', error);
        }
    }

    async startSync(): Promise<void> {
        try {
            if (!cryptoManager.getStatus().initialized) {
                throw new Error('Crypto manager must be initialized before starting sync');
            }

            // Load saved sync token
            this.lastSyncToken = await this.loadSavedSync();

            // Initial setup for rooms and participants
            await this.initialSetup();

            // Set up sync listeners
            this.setupSyncListeners();

            // Start syncing
            await this.syncApi.sync();

            // Start processing message queue
            this.startMessageQueueProcessor();
        } catch (error: any) {
            await this.handleSyncError(error);
            throw error;
        }
    }

    private async initialSetup(): Promise<void> {
        const rooms = this.client.getRooms();

        // Process rooms in batches
        const batchSize = 10;
        for (let i = 0; i < rooms.length; i += batchSize) {
            const batch = rooms.slice(i, i + batchSize);
            await Promise.all(batch.map(async (room) => {
                await this.syncRoom(room);
                await this.syncParticipants(room);
            }));
        }
    }

    private async syncRoom(room: MatrixSDK.Room): Promise<void> {
        const state = room.getLiveTimeline().getState(MatrixSDK.EventTimeline.FORWARDS);
        const roomData: RoomData = {
            id: room.roomId,
            name: room.name,
            topic: state?.getStateEvents('m.room.topic')[0]?.getContent()?.topic ?? "",
            is_encrypted: !!state?.getStateEvents(MatrixSDK.EventType.RoomEncryption, ""),
            created_ts: state?.getStateEvents('m.room.create', '')?.getTs(),
            avatar_url: state?.getStateEvents('m.room.avatar')[0]?.getContent()?.url ?? "",
            last_updated: new Date().toISOString(),
        };

        const { error } = await supabase
            .from('rooms')
            .upsert(roomData, { onConflict: 'id' });

        if (error) throw new Error(`Failed to sync room: ${error.message}`);
    }

    private async syncParticipants(room: MatrixSDK.Room): Promise<void> {
        const members = room.getJoinedMembers();

        // Process members in batches
        const batchSize = 100;
        for (let i = 0; i < members.length; i += batchSize) {
            const batch = members.slice(i, i + batchSize);
            const participantData = batch.map(member => ({
                user_id: member.userId,
                display_name: member.name,
                avatar_url: member.getMxcAvatarUrl() ?? '',
                membership: member.membership,
                room_id: room.roomId,
                joined_ts: member.events.member?.getTs(),
                last_updated: new Date().toISOString()
            }));

            const { error } = await supabase
                .from('participants')
                .upsert(participantData, { onConflict: 'user_id, room_id' });

            if (error) throw new Error(`Failed to sync participants batch: ${error.message}`);
        }
    }

    private setupSyncListeners(): void {
        // Monitor sync state changes
        this.client.on(MatrixSDK.ClientEvent.Sync, async (
            state: MatrixSDK.SyncState,
            _prevState: MatrixSDK.SyncState | null,
            data?: ISyncStateData
        ) => {
            if (state === 'ERROR') {
                await this.handleSyncError(data?.error || new Error('Unknown sync error'));
            } else {
                await this.updateSyncStatus(state.toLowerCase());
            }
        });

        // Handle new timeline events
        this.client.on(MatrixSDK.RoomEvent.Timeline, async (
            event: MatrixSDK.MatrixEvent,
            room: MatrixSDK.Room | undefined,
            toStartOfTimeline: boolean | undefined
        ) => {
            if (!toStartOfTimeline && room) {
                await this.processEvent(event, room);
            }
        });

        // Handle room state changes
        this.client.on(MatrixSDK.RoomStateEvent.Events, async (_event: MatrixSDK.MatrixEvent, state: MatrixSDK.RoomState) => {
            const room = this.client.getRoom(state.roomId);
            if (room) {
                await this.syncRoom(room);
            }
        });

        // Handle membership changes
        this.client.on(MatrixSDK.RoomEvent.MyMembership, async (room: MatrixSDK.Room, membership: string) => {
            if (room) {
                await this.syncParticipants(room);
            }
        });
    }

    private async processEvent(event: MatrixSDK.MatrixEvent, room: MatrixSDK.Room): Promise<void> {
        try {
            let content = event.getContent();

            if (event.isEncrypted()) {
                try {
                    const decrypted = await cryptoManager.decryptEvent(event);
                    if (decrypted) {
                        content = decrypted;
                    }
                } catch (error) {
                    // Queue for retry if decryption fails
                    await this.messageQueue.enqueue({
                        event,
                        room,
                        type: 'retry_decrypt'
                    });
                    return;
                }
            }

            await this.messageQueue.enqueue({
                event: event,
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

    private async startMessageQueueProcessor(): Promise<void> {
        if (this.processingQueue) return;
        this.processingQueue = true;

        while (this.processingQueue) {
            try {
                const batch = await this.messageQueue.dequeue(this.options.batchSize);
                if (batch.length === 0) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }

                // Group messages by type for efficient processing
                const messagesByType = this.groupMessagesByType(batch);

                // Process each type separately
                await Promise.all([
                    this.processMessageBatch(messagesByType.message),
                    this.processRetryDecryption(messagesByType.retry_decrypt),
                    this.processErrorMessages(messagesByType.error)
                ]);

            } catch (error) {
                console.error('Error in message queue processor:', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    private groupMessagesByType(batch: any[]): Record<string, any[]> {
        return batch.reduce((acc, item) => {
            acc[item.type] = acc[item.type] || [];
            acc[item.type].push(item);
            return acc;
        }, {} as Record<string, any[]>);
    }

    private async processMessageBatch(messages: any[] = []): Promise<void> {
        if (messages.length === 0) return;

        const formattedMessages = messages.map(item => ({
            id: item.event.getId(),
            room_id: item.room.roomId,
            sender: item.event.getSender(),
            content: item.event.content,
            timestamp: item.event.getDate()?.toISOString(),
            encrypted: item.event.isEncrypted(),
            event_type: item.event.getType(),
            processed_at: new Date().toISOString()
        }));

        const { error } = await supabase
            .from('messages')
            .upsert(formattedMessages, { onConflict: 'id' });

        if (error) {
            console.error(`Failed to store message batch: ${error.message}`);
            await Promise.all(messages.map(msg =>
                this.messageQueue.enqueue({ ...msg, type: 'retry' })
            ));
        }
    }

    private async processRetryDecryption(messages: any[] = []): Promise<void> {
        if (messages.length === 0) return;

        for (const item of messages) {
            try {
                const decrypted = await cryptoManager.decryptEvent(item.event);
                if (decrypted) {
                    await this.messageQueue.enqueue({
                        event: {
                            ...item.event,
                            content: decrypted,
                            decrypted: true
                        },
                        room: item.room,
                        type: 'message'
                    });
                } else {
                    // If still can't decrypt, queue for later retry
                    await this.messageQueue.enqueue({
                        ...item,
                        retryCount: (item.retryCount || 0) + 1
                    });
                }
            } catch (error) {
                console.error('Failed to decrypt event:', error);
            }
        }
    }

    private async processErrorMessages(messages: any[] = []): Promise<void> {
        if (messages.length === 0) return;

        // Log errors and store them for monitoring
        const errorLogs = messages.map(item => ({
            event_id: item.event.getId(),
            room_id: item.room.roomId,
            error: item.error,
            timestamp: new Date().toISOString()
        }));

        await supabase
            .from('sync_errors')
            .upsert(errorLogs, { onConflict: 'event_id' });
    }

    private async handleSyncError(error: Error): Promise<void> {
        const errorMessage = error.message;
        await this.updateSyncStatus('error', errorMessage);

        if (errorMessage.includes('decrypt') || errorMessage.includes('crypto')) {
            try {
                await cryptoManager.recoverKeys();
                // Retry sync after key recovery
                this.syncApi.retryImmediately();
            } catch (recoveryError: any) {
                console.error('Failed to recover keys:', recoveryError);
            }
        }
    }

    private async updateSyncStatus(
        state: string,
        error?: string
    ): Promise<void> {
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

    private isRoomFullySynced(roomId: string): boolean {
        // Check if we've processed all known events for this room
        const room = this.client.getRoom(roomId);
        if (!room) return false;

        const timeline = room.getLiveTimeline();
        return timeline && timeline.getPaginationToken(MatrixSDK.EventTimeline.BACKWARDS) !== null;
    }

    private async processPendingEvents(): Promise<void> {
        // Handle any pending decryption retries
        const pendingDecryption = await this.messageQueue.getPending('retry_decrypt');
        if (pendingDecryption.length > 0) {
            await this.processRetryDecryption(pendingDecryption);
        }
    }

    private async handleRoomKeyUpdate(): Promise<void> {
        // Trigger decryption retry for pending encrypted events
        const pendingDecryption = await this.messageQueue.getPending('retry_decrypt');
        await this.processRetryDecryption(pendingDecryption);
    }

    async stopSync(): Promise<void> {
        try {
            this.syncApi.stop();
            this.client.removeAllListeners();
            this.processingQueue = false;
            await this.updateSyncStatus('stopped');

            // Save current sync token
            if (this.lastSyncToken) {
                await this.saveSyncToken(this.lastSyncToken);
            }

            // Process any remaining messages in the queue
            await this.drainMessageQueue();
        } catch (error: any) {
            console.error(`Failed to stop sync: ${error.message}`);
            throw error;
        }
    }

    private async drainMessageQueue(): Promise<void> {
        // Process remaining messages in the queue
        while (await this.messageQueue.size() > 0) {
            const batch = await this.messageQueue.dequeue(this.options.batchSize);
            if (batch.length > 0) {
                const messagesByType = this.groupMessagesByType(batch);
                await Promise.all([
                    this.processMessageBatch(messagesByType.message),
                    this.processRetryDecryption(messagesByType.retry_decrypt),
                    this.processErrorMessages(messagesByType.error)
                ]);
            }
        }
    }

    async resumeSync(): Promise<void> {
        try {
            if (this.syncState.state === 'stopped') {
                // Load last sync token
                const token = await this.loadSavedSync();
                if (token) {
                    this.lastSyncToken = token;
                    // Resume sync from last known position
                    await this.syncApi.sync();
                    this.startMessageQueueProcessor();
                    await this.updateSyncStatus('syncing');
                } else {
                    // If no token, start fresh sync
                    await this.startSync();
                }
            }
        } catch (error: any) {
            await this.handleSyncError(error);
            throw error;
        }
    }

    async forceSync(): Promise<void> {
        try {
            // Force immediate sync
            if (this.syncApi.retryImmediately()) {
                await this.updateSyncStatus('syncing');
            }
        } catch (error: any) {
            await this.handleSyncError(error);
            throw error;
        }
    }

    async getSyncStatus(): Promise<{
        syncState: SyncStatus;
        queueStatus: {
            pending: number;
            processing: number;
            failed: number;
            retrying: number;
        };
        cryptoStatus: {
            initialized: boolean;
            totalKeys: number;
            backedUpKeys: number;
        };
        roomStatus: {
            total: number;
            synced: number;
            syncing: number;
            failed: number;
        };
    }> {
        const queueStatus = await this.messageQueue.getStatus();
        const cryptoStatus = cryptoManager.getStatus();
        const roomStatus = await this.getRoomStatus();

        return {
            syncState: this.syncState,
            queueStatus: {
                ...queueStatus,
                retrying: await this.messageQueue.getPending('retry_decrypt').then(p => p.length)
            },
            cryptoStatus: {
                initialized: cryptoStatus.initialized,
                totalKeys: cryptoStatus.keysStatus.totalKeys,
                backedUpKeys: cryptoStatus.keysStatus.backedUpKeys
            },
            roomStatus
        };
    }

    private async getRoomStatus(): Promise<{
        total: number;
        synced: number;
        syncing: number;
        failed: number;
    }> {
        const rooms = this.client.getRooms();
        let synced = 0;
        let syncing = 0;
        let failed = 0;

        for (const room of rooms) {
            if (this.isRoomFullySynced(room.roomId)) {
                synced++;
            } else {
                const timeline = room.getLiveTimeline();
                if (timeline && timeline.getPaginationToken(MatrixSDK.EventTimeline.BACKWARDS)) {
                    syncing++;
                } else {
                    failed++;
                }
            }
        }

        return {
            total: rooms.length,
            synced,
            syncing,
            failed
        };
    }

    async getPendingDecryption(): Promise<{
        count: number;
        events: Array<{
            roomId: string;
            eventId: string;
            timestamp: string;
            retryCount: number;
        }>;
    }> {
        const pendingEvents = await this.messageQueue.getPending('retry_decrypt');
        return {
            count: pendingEvents.length,
            events: pendingEvents.map(event => ({
                roomId: event.room.roomId,
                eventId: event.event.getId() ?? "",
                timestamp: event.event.getDate()?.toISOString() ?? new Date().toISOString(),
                retryCount: event.retryCount || 0
            }))
        };
    }

    async getFailedMessages(): Promise<{
        count: number;
        errors: Array<{
            roomId: string;
            eventId: string;
            error: string;
            timestamp: string;
        }>;
    }> {
        const { data, error } = await supabase
            .from('sync_errors')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(100);

        if (error) throw error;

        return {
            count: data.length,
            errors: data.map(error => ({
                roomId: error.room_id,
                eventId: error.event_id,
                error: error.error,
                timestamp: error.timestamp
            }))
        };
    }

    async clearFailedMessages(): Promise<void> {
        await supabase.from('sync_errors').delete().neq('event_id', '');
    }

    async retryFailedDecryption(roomId?: string): Promise<number> {
        const pendingEvents = await this.messageQueue.getPending('retry_decrypt');
        const eventsToRetry = roomId
            ? pendingEvents.filter(event => event.room.roomId === roomId)
            : pendingEvents;

        await this.processRetryDecryption(eventsToRetry);
        return eventsToRetry.length;
    }

    async resetSync(): Promise<void> {
        try {
            // Stop current sync
            await this.stopSync();

            // Clear sync state
            this.lastSyncToken = null;
            await supabase.from('sync_state').delete().neq('next_batch', '');

            // Clear message queue
            await this.messageQueue.clear();

            // Clear error logs
            await this.clearFailedMessages();

            // Start fresh sync
            await this.startSync();
        } catch (error: any) {
            await this.handleSyncError(error);
            throw error;
        }
    }

    async getRoomSyncProgress(roomId: string): Promise<{
        status: 'synced' | 'syncing' | 'failed';
        progress: number;
        messageCount: number;
        lastMessage?: {
            timestamp: string;
            sender: string;
        };
    }> {
        const room = this.client.getRoom(roomId);
        if (!room) {
            throw new Error('Room not found');
        }

        const timeline = room.getLiveTimeline();
        const isFullySynced = this.isRoomFullySynced(roomId);

        const { count } = await supabase
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('room_id', roomId);

        const { data: lastMessage } = await supabase
            .from('messages')
            .select('timestamp, sender')
            .eq('room_id', roomId)
            .order('timestamp', { ascending: false })
            .limit(1)
            .single();

        let status: 'synced' | 'syncing' | 'failed' = 'failed';
        let progress = 0;

        if (isFullySynced) {
            status = 'synced';
            progress = 100;
        } else if (timeline && timeline.getPaginationToken(MatrixSDK.EventTimeline.BACKWARDS)) {
            status = 'syncing';
            // estimate progress based on timeline events vs total known events
            const timelineEvents = timeline.getEvents().length;
            const totalEvents = room.getUnfilteredTimelineSet().getLiveTimeline().getEvents().length;
            progress = Math.min(Math.round((timelineEvents / totalEvents) * 100), 99);
        }

        return {
            status,
            progress,
            messageCount: count || 0,
            lastMessage: lastMessage ? {
                timestamp: lastMessage.timestamp,
                sender: lastMessage.sender
            } : undefined
        };
    }
}
