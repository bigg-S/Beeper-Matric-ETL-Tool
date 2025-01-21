import * as MatrixSDK from 'matrix-js-sdk';
import { MatrixEvent, PendingEventOrdering } from 'matrix-js-sdk';
import { cryptoManager } from './crypto';
import { pgPool } from '../db/client';
import { EventEmitter } from 'events';
import * as dotenv from 'dotenv';
import { UserPayload } from '../types';

dotenv.config();

export class MatrixClient extends EventEmitter {
  private client: MatrixSDK.MatrixClient | null | undefined;
  private authConfig: UserPayload;
  private syncToken: string | null = null;
  private userId: string = "";
  private isInitialized = false;

  constructor(authConfig: UserPayload) {
    super();
    this.authConfig = authConfig;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log("Matrix client already initialized.");
      return;
    }

    try {
      this.client = MatrixSDK.createClient({
        baseUrl: this.authConfig.domain,
        userId: `@${this.authConfig.username}:${this.authConfig.domain}`,
      });

      await this.login();

      await this.setupCrypto();

      await this.loadSyncToken();

      await this.startSync();

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
      this.syncToken = null;

      const userId = this.client.getUserId();
      if (userId) {
        await pgPool.query(
          'DELETE FROM auth_credentials WHERE user_id = $1',
          [userId]
        );
      }

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
    
    await cryptoManager.initCrypto(this.client, this.authConfig.password);

    await this.client.initRustCrypto();

    const cryptoApi = this.client.getCrypto();
    if (cryptoApi) {
      const keyBackupInfo = await cryptoApi.getKeyBackupInfo();
      console.log(keyBackupInfo)
      if (!keyBackupInfo) {
        console.log("No backup info: checking and enabling...")
        await cryptoApi.checkKeyBackupAndEnable();
      }
    }

    console.log("here authuploading device signing keys")
    this.client.getCrypto()?.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest) => {
        return makeRequest(this.authConfig).then(() => {});
      },
    });

    this.client.on(MatrixSDK.Crypto.CryptoEvent.KeyBackupStatus, async (status) => {
      await this.handleKeyBackupStatus(status);
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

  private async loadSyncToken() {
    const query = `
      SELECT next_batch
      FROM sync_status
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const result = await pgPool.query(query);
    this.syncToken = result.rows[0]?.next_batch || null;
  }

  private async startSync() {
    if (!this.client) {
      throw new Error("Client not created");
    }

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
      pendingEventOrdering: 'chronological' as PendingEventOrdering,
    });
  }

  private async saveSyncToken() {
    if (this.syncToken) {
      const query = `
        INSERT INTO sync_status (next_batch, created_at)
        VALUES ($1, $2)
      `;

      await pgPool.query(query, [
        this.syncToken,
        new Date().toISOString()
      ]);
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

  //     await pgPool.from('rooms').upsert(roomData, { onConflict: 'id' });
  // }

  private async processEvent(event: MatrixEvent) {
    if (event.getType() !== 'm.room.message') return;

    try {
      let content = event.getContent();

      if (event.isEncrypted()) {
        const decryptedEvent = await cryptoManager.decryptEvent(event);
        content = decryptedEvent.getContent();
      }

      const query = `
        INSERT INTO messages (
          id, room_id, sender, content, msgtype,
          timestamp, encrypted, edited, deleted, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          edited = EXCLUDED.edited,
          deleted = EXCLUDED.deleted
      `;

      await pgPool.query(query, [
        event.getId(),
        event.getRoomId(),
        event.getSender(),
        content.body,
        content.msgtype,
        event.getDate()?.toISOString(),
        event.isEncrypted(),
        false,
        false,
        new Date().toISOString()
      ]);
    } catch (error: any) {
      console.error(`Failed to process event ${event.getId()}:`, error);
      await pgPool.query(
        `INSERT INTO failed_events (event_id, room_id, error, retry_count, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          event.getId(),
          event.getRoomId(),
          error.message,
          0,
          new Date().toISOString()
        ]
      );
    }
  }

  // private async handleDeviceVerification(userId: string, deviceId: string) {
  //     const device = await this.client.getDevice(deviceId) as IMyDevice;
  //     await pgPool.from('device_verifications').insert({
  //         user_id: userId,
  //         device_id: deviceId,
  //         display_name: device.display_name,
  //         updated_at: new Date().toISOString(),
  //     });
  // }

  private async handleKeyBackupStatus(status: boolean) {
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

  private async updateSyncStatus(state: string, data: any) {
    const query = `
      INSERT INTO sync_status (
        state,
        next_batch,
        created_at
      ) VALUES ($1, $2, $3)
    `;

    await pgPool.query(query, [
      state,
      data?.nextBatch,
      new Date().toISOString()
    ]);
  }

  public getClient() {
    return this.client;
  }
}
