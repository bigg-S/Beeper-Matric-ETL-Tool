import * as MatrixSDK from 'matrix-js-sdk';
import { pgPool } from '../db/client';
import { SyncManagerOptions, SyncStatus } from '../types';
import { cryptoManager } from './crypto';
import { SyncApi, SyncApiOptions } from 'matrix-js-sdk/lib/sync';
import { persistMessage, persistParticipants, persistRoom } from './utils/db.utils';

export class SyncManager {
  private client: MatrixSDK.MatrixClient | undefined;
  private syncApi: SyncApi | undefined;
  private syncState: SyncStatus = {
    state: 'initializing',
    lastSync: undefined,
    error: undefined,
  };
  private readonly options: Required<SyncManagerOptions>;

  constructor(options?: SyncManagerOptions) {
    this.options = {
      batchSize: options?.batchSize || 1000,
      initialSyncLimit: options?.initialSyncLimit || 30,
      timeoutMs: options?.timeoutMs || 30000,
      maxTimelineEntries: options?.maxTimelineEntries || 50,
    };
  }

  async initialize(client: MatrixSDK.MatrixClient) {
    this.client = client;

    const storedClientOpts: MatrixSDK.IStoredClientOpts = {};
    const syncOpts: SyncApiOptions = {
      cryptoCallbacks: {
        onSyncCompleted: async () => {
          this.syncState = { state: "synced", lastSync: new Date(), error: undefined };
        },
        preprocessToDeviceMessages: function (
          _events: MatrixSDK.IToDeviceEvent[]
        ): Promise<MatrixSDK.IToDeviceEvent[]> {
          throw new Error('Function not implemented.');
        },
        processKeyCounts: function (
          _oneTimeKeysCounts?: Record<string, number>,
          _unusedFallbackKeys?: string[]
        ): Promise<void> {
          throw new Error('Function not implemented.');
        },
        processDeviceLists: function (_deviceLists: MatrixSDK.IDeviceLists): Promise<void> {
          throw new Error('Function not implemented.');
        },
        onCryptoEvent: function (
          _room: MatrixSDK.Room,
          _event: MatrixSDK.MatrixEvent
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

  }

  async startSync(): Promise<void> {
    try {
      if (!cryptoManager.getDetailedStatus()) {
        throw new Error('Crypto manager must be initialized before starting sync');
      }

      // Set up sync listeners
      this.setupEventListeners();

      // Start syncing
      await this.syncApi?.sync();

      this.syncState.state = "syncing";

    } catch (error: any) {
      await this.handleSyncError(error);
      this.syncState.state = "error";
      throw error;
    }
  }

  private async setupEventListeners(): Promise<void> {
    if(!this.client) {
      console.log("Client not initialized");
      return;
    }

    this.client.on(MatrixSDK.RoomEvent.Timeline, async  (event, room, toStartOfTimeline) => {
      if(!room) {
        return;
      }

      if (toStartOfTimeline) {
        return; // don't retrieve paginated results
      }

      if (event.getType() === "m.room.message") {
        await persistMessage(room?.roomId, event);
        await persistRoom(room);
        await persistParticipants(room);
      }
    });

  }

  private async handleSyncError(error: Error): Promise<void> {
    const errorMessage = error.message;
    this.syncState.error = "error";

    if (errorMessage.includes('decrypt') || errorMessage.includes('crypto')) {
      try {
        await cryptoManager.recoverKeys();
        // Retry sync after key recovery
        this.syncApi!.retryImmediately();
      } catch (recoveryError: any) {
        console.error('Failed to recover keys:', recoveryError);
      }
    }
  }

  private isRoomFullySynced(roomId: string): boolean {
    // Check if we've processed all known events for this room
    const room = this.client?.getRoom(roomId);
    if (!room) return false;

    const timeline = room.getLiveTimeline();
    return timeline && timeline.getPaginationToken(MatrixSDK.EventTimeline.BACKWARDS) !== null;
  }

  async stopSync(): Promise<void> {
    try {
      this.syncApi!.stop();
      this.client!.removeAllListeners();
      this.syncState.state = "stopped";
    } catch (error: any) {
      console.error(`Failed to stop sync: ${error.message}`);
      throw error;
    }
  }

  async getSyncStatus() {
    return this.syncState.state;
  }

  async clearFailedMessages(): Promise<void> {
    await pgPool.query('DELETE FROM sync_errors');
  }

}

export const syncManager = new SyncManager();
