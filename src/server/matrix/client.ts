import { StoredSyncData } from './../types/index';
import * as MatrixSDK from 'matrix-js-sdk';
import { PendingEventOrdering } from 'matrix-js-sdk';
import { cryptoManager } from './crypto';
import { pgPool } from '../db/client';
import { EventEmitter } from 'events';
import * as dotenv from 'dotenv';
import { SyncManagerOptions, UserPayload } from '../types';

dotenv.config();

export class MatrixClient extends EventEmitter {
  private client: MatrixSDK.MatrixClient | null | undefined;
  private authConfig: UserPayload;
  private syncAccumulator: MatrixSDK.SyncAccumulator;
  private latestSyncData: StoredSyncData | null = null;
  private readonly options: Required<SyncManagerOptions>;
  private userId: string = "";
  private isInitialized = false;

  constructor(authConfig: UserPayload, options?: SyncManagerOptions) {
    super();
    this.authConfig = authConfig;
    this.options = {
      batchSize: options?.batchSize || 1000,
      initialSyncLimit: options?.initialSyncLimit || 30,
      timeoutMs: options?.timeoutMs || 30000,
      maxTimelineEntries: options?.maxTimelineEntries || 50,
    };
    this.syncAccumulator = new MatrixSDK.SyncAccumulator({
      maxTimelineEntries: this.options.maxTimelineEntries,
    });
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log("Matrix client already initialized.");
      return;
    }

    try {
      this.client = MatrixSDK.createClient({
        baseUrl: this.authConfig.domain,
        userId: `@${this.authConfig.username}:${this.authConfig.domain}`
      });

      await this.login();

      await this.setupCrypto();

      await this.loadLatestSyncData();

      if(this.latestSyncData?.nextBatch) {
        this.resumeSync(this.latestSyncData);
      } else {
        await this.startFreshSync();
      }

      this.isInitialized = true;
      console.log("Matrix client fully initialized.");

    } catch (error) {
      console.error("Failed to initialize Matrix client:", error);
      this.client = null;
      throw error;
    }
  }

  public isClientInitialized(): boolean {
    return this.isInitialized;
  }

  private async login() {
    if (!this.client) {
      throw new Error("Client not created");
    }

    try {
      this.userId = this.client.getUserId()?.replace(/^(.+?):https:\/\/matrix\.(.+)$/, '$1:$2') || "";
      const existingCredentials = await this.getExistingCredentials();

      if (existingCredentials) {
        this.client.deviceId = existingCredentials.device_id;
        this.client.setAccessToken(existingCredentials.access_token);
        this.client.credentials = { userId: this.client.getUserId() };
        console.log("User logged in using existing credentials.");
        return;
      }

      const loginResponse = await this.client.login('m.login.password', {
        user: this.authConfig.username,
        password: this.authConfig.password,
      });

      const query = `
        INSERT INTO auth_credentials (
          user_id, device_id, access_token, refresh_token, domain, homeserver_url, expires_in_ms, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `;

      await pgPool.query(query, [
        this.client.getUserId(),
        loginResponse.device_id,
        loginResponse.access_token,
        loginResponse.refresh_token,
        this.authConfig.domain,
        this.client.getUserId()?.split(":")[1],
        loginResponse.expires_in_ms,
        new Date().toISOString()
      ]);

      this.client.deviceId = loginResponse.device_id;
      this.client.setAccessToken(loginResponse.access_token);
      this.client.credentials = { userId: this.client.getUserId() };

      console.log("User logged in and credentials saved.", this.client.getUserId());
    } catch (error: any) {
      console.error(`Failed to login:`, error);
      throw new Error(`Failed to login: ${error.message}`);
    }
  }

  public async logout() {
    if (!this.client) {
      throw new Error("Client not created");
    }

    try {
      await this.client.logout();

      this.client.stopClient();
      console.log('Successfully logged out');
    } catch (error: any) {
      console.error(`Failed to logout: ${error.message}`);
      throw new Error(`Logout failed: ${error.message}`);
    }
  }

  public async getUserProfile(userId: string) {
    if (!this.client) {
      throw new Error("Client not created");
    }

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
    if (!this.client) {
      throw new Error("Client not created");
    }

    await cryptoManager.initCrypto(this.client, this.userId, this.client.deviceId ?? "", this.authConfig.password);

    // initialize end to end encryption
    await this.client.initRustCrypto();

    const cryptoApi = this.client.getCrypto();
    if (cryptoApi) {
      const hasKeyBackup = (await cryptoApi.checkKeyBackupAndEnable()) !== null;
      if (hasKeyBackup == null) {
        // create a new key backup
        await cryptoApi.resetKeyBackup();
      }
    }

    // verify new devices
    cryptoApi?.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => {
        return makeRequest(this.authConfig).then(() => {});
      },
    });

    this.client.on(MatrixSDK.Crypto.CryptoEvent.KeyBackupStatus, async (status) => {
      await this.setKeyBackupStatus(status);
    });
  }

  private async getExistingCredentials() {
    try {
      const result = await pgPool.query(
        'SELECT device_id, access_token FROM auth_credentials WHERE user_id = $1',
        [this.userId]
      );
      if (result.rows.length > 0) {
        return result.rows[0];
      } else {
        return null;
      }
    } catch (error) {
      console.error("Error fetching credentials:", error);
      return null;
    }
  }

  private async loadLatestSyncData() {
    const query = `
      SELECT *
      FROM sync_state
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const result = await pgPool.query(query);
    this.latestSyncData = result.rows[0] || null;
  }

  private async startFreshSync() {
    if (!this.client) {
      throw new Error("Client not created");
    }

    const filterDef = new MatrixSDK.Filter(this.userId!);
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
        await this.updateSyncState(state, data ?? {});
      }
    });

    this.setupEventListeners();

    await this.client.startClient({
      filter: filterDef,
      initialSyncLimit: 50,
      pendingEventOrdering: 'chronological' as PendingEventOrdering,
    });
  }

  private async resumeSync(storedSync: StoredSyncData) {
    try {

      const syncResponse = {
        "next_batch": storedSync.syncData.nextBatch,
        "account_data": storedSync.syncData.accountData,
        "rooms": storedSync.syncData.roomsData
      };
      // load the stored sync data into the accumulator
      this.syncAccumulator.accumulate(syncResponse as any, true);

      // setup event listeners
      this.setupEventListeners();

      // start syncing
      await this.client?.startClient();

    } catch (error) {
      console.error('Failed to resume sync:', error);
      // If resume fails, fall back to fresh sync
      await this.startFreshSync();
    }
  }

  private async updateSyncState(state: string, data: MatrixSDK.SyncStateData) {
    const query = `
      INSERT INTO sync_state (
        next_batch,
        state,
        sync_data,
        created_at
      ) VALUES ($1, $2, $3, $4)
    `;

    await pgPool.query(query, [
      state,
      data.nextSyncToken,
      data,
      new Date().toISOString()
    ]);
  }

  private async setupEventListeners(): Promise<void> {
    if(!this.client) {
      console.log("Client not initialized");
      return;
    }

    this.client.on(MatrixSDK.RoomEvent.Timeline, async  (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) {
        return; // don't retrieve paginated results
      }

      if (event.getType() === "m.room.message") {
        await this.persistMessage(room?.roomId, event);
      }
      else if(event.getType() === "m.") {

      }
    });

  }

  private async persistMessage(roomId: string | undefined, event: MatrixSDK.MatrixEvent): Promise<void> {
    try {
    const query = `
      INSERT INTO messages (event_id, room_id, sender, content, event_type, timestamp, is_encrypted, relates_to, error)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (event_id) DO UPDATE SET
        room_id = EXCLUDED.room_id,
        sender = EXCLUDED.sender,
        content = EXCLUDED.content,
        event_type = EXCLUDED.type,
        timestamp = EXCLUDED.timestamp,
        is_encrypted = EXCLUDED.is_encrypted,
        relates_to,
        error
    `;

    const values = [
      event.getId(),
      roomId,
      event.sender,
      JSON.stringify(event.getContent()),
      event.getType(),
      event.getTs(),
      event.isEncrypted(),
      JSON.stringify(event.getRelation()),
      event.error
    ];

    await pgPool.query(query, values);
    } catch (error) {
      console.error("Error persisting message:", error);
      throw error;
    }
  }

  private async persistParticipants(roomId: string, members: MatrixSDK.RoomMember): Promise<void> {
    const participantsData = Object.values(members).map((member: any) => ({
      room_id: roomId,
      user_id: member.userId,
      display_name: member.name,
      avatar_url: member.avatarUrl,
      membership: member.membership,
    }));

    try {
      await pgPool.query(
        `INSERT INTO participants (room_id, user_id, display_name, avatar_url, membership) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (room_id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name, avatar_url = EXCLUDED.avatar_url, membership = EXCLUDED.membership`,
        participantsData.map((participant) => [
          participant.room_id,
          participant.user_id,
          participant.display_name,
          participant.avatar_url,
          participant.membership,
        ])
      );
    } catch (error) {
      console.error('Error persisting participants:', error);
      throw error;
    }
  }

  private async persistRoom(room: MatrixSDK.Room): Promise<void> {
    try {
      await pgPool.query(
        `INSERT INTO rooms (room_id, name, topic, is_encrypted, created_ts) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (room_id) DO UPDATE SET name = EXCLUDED.name, topic = EXCLUDED.topic, is_encrypted = EXCLUDED.is_encrypted, created_ts = EXCLUDED.created_ts`,
        [room.roomId, room.name, room.topic, room.encrypted, room.getCreationTs()]
      );
    } catch (error) {
      console.error('Error persisting room:', error);
      throw error;
    }
  }


  private async setKeyBackupStatus(status: boolean) {
    const query = `
      INSERT INTO key_backup_status (
        status,
        created_at
      ) VALUES ($1, $2)
    `;

    await pgPool.query(query, [
      status,
      new Date().toISOString()
    ]);
  }

  public getClient() {
    return this.client;
  }
}
