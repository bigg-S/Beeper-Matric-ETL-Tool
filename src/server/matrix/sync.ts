import * as MatrixSDK from 'matrix-js-sdk';
import { pgPool } from '../db/client';
import { RoomData, SyncManagerOptions, SyncStatus } from '../types';
import { cryptoManager } from './crypto';
import { MessageQueueImpl } from '@/server/types/message-queue';
import { ISyncStateData, SyncApi, SyncApiOptions } from 'matrix-js-sdk/lib/sync';

export class SyncManager {
  private client: MatrixSDK.MatrixClient;
  private syncApi: SyncApi;
  private syncAccumulator: MatrixSDK.SyncAccumulator;
  private syncState: SyncStatus = {
    state: 'initializing',
    lastSync: undefined,
    error: undefined,
  };
  private messageQueue: MessageQueueImpl;
  private readonly options: Required<SyncManagerOptions>;
  private processingQueue: boolean = false;
  private lastSyncToken: string | null = null;

  constructor(client: MatrixSDK.MatrixClient, options?: SyncManagerOptions) {
    this.client = client;
    this.options = {
      batchSize: options?.batchSize || 1000,
      initialSyncLimit: options?.initialSyncLimit || 30,
      timeoutMs: options?.timeoutMs || 30000,
      maxTimelineEntries: options?.maxTimelineEntries || 50,
    };

    // Initialize SyncAccumulator with max timeline entries
    this.syncAccumulator = new MatrixSDK.SyncAccumulator({
      maxTimelineEntries: this.options.maxTimelineEntries,
    });

    const storedClientOpts: MatrixSDK.IStoredClientOpts = {};
    const syncOpts: SyncApiOptions = {
      cryptoCallbacks: {
        onSyncCompleted: async () => {
          await this.processPendingEvents();
        },
        preprocessToDeviceMessages: function (
          events: MatrixSDK.IToDeviceEvent[]
        ): Promise<MatrixSDK.IToDeviceEvent[]> {
          throw new Error('Function not implemented.');
        },
        processKeyCounts: function (
          oneTimeKeysCounts?: Record<string, number>,
          unusedFallbackKeys?: string[]
        ): Promise<void> {
          throw new Error('Function not implemented.');
        },
        processDeviceLists: function (deviceLists: MatrixSDK.IDeviceLists): Promise<void> {
          throw new Error('Function not implemented.');
        },
        onCryptoEvent: function (
          room: MatrixSDK.Room,
          event: MatrixSDK.MatrixEvent
        ): Promise<void> {
          throw new Error('Function not implemented.');
        },
      },
      canResetEntireTimeline: (roomId: string) => {
        // Only allow timeline reset if we've fully processed the room
        return this.isRoomFullySynced(roomId);
      },
    };

    this.syncApi = new SyncApi(client, storedClientOpts, syncOpts);

    this.messageQueue = new MessageQueueImpl(this.options.batchSize);
  }

  private async loadSavedSync(): Promise<string | null> {
    try {
      const query = `
        SELECT next_batch
        FROM sync_state
        ORDER BY created_at DESC
        LIMIT 1
      `;

      const result = await pgPool.query(query);
      return result.rows[0]?.next_batch || null;
    } catch (error) {
      console.warn('Failed to load saved sync token:', error);
      return null;
    }
  }

  private async saveSyncToken(token: string): Promise<void> {
    try {
      const query = `
        INSERT INTO sync_state (next_batch, created_at)
        VALUES ($1, $2)
        ON CONFLICT (next_batch) DO UPDATE
        SET created_at = EXCLUDED.created_at
      `;

      await pgPool.query(query, [token, new Date().toISOString()]);
    } catch (error) {
      console.error('Failed to save sync token:', error);
    }
  }

  async startSync(): Promise<void> {
    try {
      if (!cryptoManager.getDetailedStatus()) {
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
      await Promise.all(
        batch.map(async (room) => {
          await this.syncRoom(room);
          await this.syncParticipants(room);
        })
      );
    }
  }

  private async syncRoom(room: MatrixSDK.Room): Promise<void> {
    const state = room.getLiveTimeline().getState(MatrixSDK.EventTimeline.FORWARDS);
    const roomData = {
      id: room.roomId,
      name: room.name,
      topic: state?.getStateEvents('m.room.topic')[0]?.getContent()?.topic ?? '',
      is_encrypted: !!state?.getStateEvents(MatrixSDK.EventType.RoomEncryption, ''),
      created_ts: state?.getStateEvents('m.room.create', '')?.getTs(),
      avatar_url: state?.getStateEvents('m.room.avatar')[0]?.getContent()?.url ?? '',
      last_updated: new Date().toISOString()
    };

    const query = `
      INSERT INTO rooms (
        id, name, topic, is_encrypted, created_ts,
        avatar_url, last_updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        topic = EXCLUDED.topic,
        is_encrypted = EXCLUDED.is_encrypted,
        avatar_url = EXCLUDED.avatar_url,
        last_updated = EXCLUDED.last_updated
    `;

    try {
      await pgPool.query(query, [
        roomData.id,
        roomData.name,
        roomData.topic,
        roomData.is_encrypted,
        roomData.created_ts,
        roomData.avatar_url,
        roomData.last_updated
      ]);
    } catch (error: any) {
      throw new Error(`Failed to sync room: ${error.message}`);
    }
  }

  private async syncParticipants(room: MatrixSDK.Room): Promise<void> {
    const members = room.getJoinedMembers();
    const batchSize = 100;

    for (let i = 0; i < members.length; i += batchSize) {
      const batch = members.slice(i, i + batchSize);
      const query = `
        INSERT INTO participants (
          user_id, display_name, avatar_url, membership,
          room_id, joined_ts, last_updated
        )
        VALUES
          ${batch.map((_, index) =>
            `($${index * 7 + 1}, $${index * 7 + 2}, $${index * 7 + 3}, $${index * 7 + 4}, $${index * 7 + 5}, $${index * 7 + 6}, $${index * 7 + 7})`
          ).join(',')}
        ON CONFLICT (user_id, room_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          avatar_url = EXCLUDED.avatar_url,
          membership = EXCLUDED.membership,
          last_updated = EXCLUDED.last_updated
      `;

      const values = batch.flatMap(member => [
        member.userId,
        member.name,
        member.getMxcAvatarUrl() ?? '',
        member.membership,
        room.roomId,
        member.events.member?.getTs(),
        new Date().toISOString()
      ]);

      try {
        await pgPool.query(query, values);
      } catch (error: any) {
        throw new Error(`Failed to sync participants batch: ${error.message}`);
      }
    }
  }

  private setupSyncListeners(): void {
    // Monitor sync state changes
    this.client.on(
      MatrixSDK.ClientEvent.Sync,
      async (
        state: MatrixSDK.SyncState,
        _prevState: MatrixSDK.SyncState | null,
        data?: ISyncStateData
      ) => {
        if (state === 'ERROR') {
          await this.handleSyncError(data?.error || new Error('Unknown sync error'));
        } else {
          await this.updateSyncStatus(state.toLowerCase());
        }
      }
    );

    // Handle new timeline events
    this.client.on(
      MatrixSDK.RoomEvent.Timeline,
      async (
        event: MatrixSDK.MatrixEvent,
        room: MatrixSDK.Room | undefined,
        toStartOfTimeline: boolean | undefined
      ) => {
        if (!toStartOfTimeline && room) {
          await this.processEvent(event, room);
        }
      }
    );

    // Handle room state changes
    this.client.on(
      MatrixSDK.RoomStateEvent.Events,
      async (_event: MatrixSDK.MatrixEvent, state: MatrixSDK.RoomState) => {
        const room = this.client.getRoom(state.roomId);
        if (room) {
          await this.syncRoom(room);
        }
      }
    );

    // Handle membership changes
    this.client.on(
      MatrixSDK.RoomEvent.MyMembership,
      async (room: MatrixSDK.Room, membership: string) => {
        if (room) {
          await this.syncParticipants(room);
        }
      }
    );
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
            type: 'retry_decrypt',
          });
          return;
        }
      }

      await this.messageQueue.enqueue({
        event: event,
        room,
        type: 'message',
      });
    } catch (error: any) {
      console.error(`Failed to process event: ${error.message}`);
      await this.messageQueue.enqueue({
        event,
        room,
        type: 'error',
        error: error.message,
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
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }

        // Group messages by type for efficient processing
        const messagesByType = this.groupMessagesByType(batch);

        // Process each type separately
        await Promise.all([
          this.processMessageBatch(messagesByType.message),
          this.processRetryDecryption(messagesByType.retry_decrypt),
          this.processErrorMessages(messagesByType.error),
        ]);
      } catch (error) {
        console.error('Error in message queue processor:', error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private groupMessagesByType(batch: any[]): Record<string, any[]> {
    return batch.reduce(
      (acc, item) => {
        acc[item.type] = acc[item.type] || [];
        acc[item.type].push(item);
        return acc;
      },
      {} as Record<string, any[]>
    );
  }

  private async processMessageBatch(messages: any[] = []): Promise<void> {
    if (messages.length === 0) return;

    const query = `
      INSERT INTO messages (
        id, room_id, sender, content, timestamp,
        encrypted, event_type, processed_at
      )
      VALUES
        ${messages.map((_, index) =>
          `($${index * 8 + 1}, $${index * 8 + 2}, $${index * 8 + 3}, $${index * 8 + 4}, $${index * 8 + 5}, $${index * 8 + 6}, $${index * 8 + 7}, $${index * 8 + 8})`
        ).join(',')}
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        processed_at = EXCLUDED.processed_at
    `;

    const values = messages.flatMap(item => [
      item.event.getId(),
      item.room.roomId,
      item.event.getSender(),
      item.event.content,
      item.event.getDate()?.toISOString(),
      item.event.isEncrypted(),
      item.event.getType(),
      new Date().toISOString()
    ]);

    try {
      await pgPool.query(query, values);
    } catch (error: any) {
      console.error(`Failed to store message batch: ${error.message}`);
      await Promise.all(
        messages.map(msg => this.messageQueue.enqueue({ ...msg, type: 'retry' }))
      );
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
              decrypted: true,
            },
            room: item.room,
            type: 'message',
          });
        } else {
          // If still can't decrypt, queue for later retry
          await this.messageQueue.enqueue({
            ...item,
            retryCount: (item.retryCount || 0) + 1,
          });
        }
      } catch (error) {
        console.error('Failed to decrypt event:', error);
      }
    }
  }

  private async processErrorMessages(messages: any[] = []): Promise<void> {
    if (messages.length === 0) return;

    const query = `
      INSERT INTO sync_errors (
        event_id, room_id, error, timestamp
      )
      VALUES
        ${messages.map((_, index) =>
          `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`
        ).join(',')}
      ON CONFLICT (event_id) DO UPDATE SET
        error = EXCLUDED.error,
        timestamp = EXCLUDED.timestamp
    `;

    const values = messages.flatMap(item => [
      item.event.getId(),
      item.room.roomId,
      item.error,
      new Date().toISOString()
    ]);

    await pgPool.query(query, values);
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

  private async updateSyncStatus(state: string, error?: string): Promise<void> {
    this.syncState = {
      state: state as SyncStatus['state'],
      lastSync: new Date(),
      error,
    };

    const query = `
      INSERT INTO sync_status (
        state, last_sync, error
      ) VALUES ($1, $2, $3)
      ON CONFLICT (state) DO UPDATE SET
        last_sync = EXCLUDED.last_sync,
        error = EXCLUDED.error
    `;

    await pgPool.query(query, [
      this.syncState.state,
      this.syncState.lastSync?.toISOString(),
      this.syncState.error
    ]);
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
    while ((await this.messageQueue.size()) > 0) {
      const batch = await this.messageQueue.dequeue(this.options.batchSize);
      if (batch.length > 0) {
        const messagesByType = this.groupMessagesByType(batch);
        await Promise.all([
          this.processMessageBatch(messagesByType.message),
          this.processRetryDecryption(messagesByType.retry_decrypt),
          this.processErrorMessages(messagesByType.error),
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
        retrying: await this.messageQueue.getPending('retry_decrypt').then((p) => p.length),
      },
      cryptoStatus: {
        initialized: cryptoStatus.initialized,
        totalKeys: cryptoStatus.keysStatus.totalKeys,
        backedUpKeys: cryptoStatus.keysStatus.backedUpKeys,
      },
      roomStatus,
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
      failed,
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
      events: pendingEvents.map((event) => ({
        roomId: event.room.roomId,
        eventId: event.event.getId() ?? '',
        timestamp: event.event.getDate()?.toISOString() ?? new Date().toISOString(),
        retryCount: event.retryCount || 0,
      })),
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
    const query = `
      SELECT * FROM sync_errors
      ORDER BY timestamp DESC
      LIMIT 100
    `;

    try {
      const result = await pgPool.query(query);
      return {
        count: result.rows.length,
        errors: result.rows.map(error => ({
          roomId: error.room_id,
          eventId: error.event_id,
          error: error.error,
          timestamp: error.timestamp
        }))
      };
    } catch (error: any) {
      throw error;
    }
  }

  async clearFailedMessages(): Promise<void> {
    await pgPool.query('DELETE FROM sync_errors');
  }

  async resetSync(): Promise<void> {
    try {
      await this.stopSync();
      this.lastSyncToken = null;

      await pgPool.query('DELETE FROM sync_state');
      await this.messageQueue.clear();
      await this.clearFailedMessages();

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

    const countQuery = `
      SELECT COUNT(*) as count
      FROM messages
      WHERE room_id = $1
    `;

    const lastMessageQuery = `
      SELECT timestamp, sender
      FROM messages
      WHERE room_id = $1
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    const timeline = room.getLiveTimeline();
    const isFullySynced = this.isRoomFullySynced(roomId);

    try {
      const [countResult, lastMessageResult] = await Promise.all([
        pgPool.query(countQuery, [roomId]),
        pgPool.query(lastMessageQuery, [roomId])
      ]);

      let status: 'synced' | 'syncing' | 'failed' = 'failed';
      let progress = 0;

      if (isFullySynced) {
        status = 'synced';
        progress = 100;
      } else if (timeline && timeline.getPaginationToken(MatrixSDK.EventTimeline.BACKWARDS)) {
        status = 'syncing';
        const timelineEvents = timeline.getEvents().length;
        const totalEvents = room.getUnfilteredTimelineSet().getLiveTimeline().getEvents().length;
        progress = Math.min(Math.round((timelineEvents / totalEvents) * 100), 99);
      }

      return {
        status,
        progress,
        messageCount: parseInt(countResult.rows[0].count) || 0,
        lastMessage: lastMessageResult.rows[0] ? {
          timestamp: lastMessageResult.rows[0].timestamp,
          sender: lastMessageResult.rows[0].sender
        } : undefined
      };
    } catch (error: any) {
      throw new Error(`Failed to get room sync progress: ${error.message}`);
    }
  }
}
