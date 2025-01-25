import * as MatrixSDK from 'matrix-js-sdk';
import { EventEmitter } from 'events';
import * as dotenv from 'dotenv';
import { UserPayload } from '../types';
import { getExistingCredentials, persistMessage, setAuthCredentials, setKeyBackupStatus, updateSyncToken } from './utils/db.utils';
import { CryptoManager } from './crypto';

dotenv.config();

// TODO: initial database update logic based on whther sync tokem exists in db or not
export class MatrixClient extends EventEmitter {
  private client: MatrixSDK.MatrixClient | null = null;
  private cryptoManager: CryptoManager | null = null;
  private authConfig: UserPayload;
  private userId: string = '';
  private accessToken: string = '';
  private isInitialized = false;
  private isInitializing = false;

  constructor(authConfig: UserPayload) {
    super();
    this.authConfig = authConfig;
  }

  async initialize(): Promise<{token: string}> {
    if(this.client !== null) {
      return {token: this.accessToken};
    }

    if (this.isInitializing) {
      console.log('Matrix client initialization in progress.');
      return {token: this.accessToken};
    }

    if (this.isInitialized) {
      console.log('Matrix client already initialized.');
      return {token: this.accessToken};
    }

    this.isInitializing = true;

    try {
      this.client = MatrixSDK.createClient({
        baseUrl: this.authConfig.domain,
        userId: `@${this.authConfig.username}:${this.authConfig.domain}`,
        cryptoStore: new MatrixSDK.IndexedDBCryptoStore(indexedDB, 'matrix-crypto-store'),
        verificationMethods: ['m.sas.v1'],
      });

      if(!this.client.isLoggedIn()) {
        await this.login();
      }

      await this.setupCrypto();
      await this.setupEventListeners();

      if(!this.client.clientRunning) {
        await this.client.startClient({initialSyncLimit: 500, lazyLoadMembers: true})
      }

      const syncToken = await this.client.store.getSavedSyncToken();

      await updateSyncToken(syncToken ?? "");

      this.isInitialized = true;
      console.log('Matrix client fully initialized.');

      return {token: this.accessToken};
    } catch (error: any) {
      console.error('Failed to initialize Matrix client:', error);
      this.client = null;
      throw error;
    } finally {
      this.isInitializing = false;
    }
  }

  private async login(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not created');
    }

    try {
      const existingCredentials = await this.getExistingSession();

      if (existingCredentials) {
        console.log('Using existing credentials.');
        return;
      }

      const authResponse = await this.client.login('m.login.password', {
        user: this.authConfig.username,
        password: this.authConfig.password,
      });

      await setAuthCredentials(this.client, authResponse, this.authConfig);
      console.log('User logged in and credentials saved.', this.client.getUserId());

      this.accessToken = authResponse.access_token;
    } catch (error: any) {
      console.error('Failed to login:', error);
      throw new Error(`Failed to login: ${error.message}`);
    }
  }

  private async getExistingSession(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    this.userId = this.client.getUserId()?.replace(/^(.+?):https:\/\/matrix\.(.+)$/, '$1:$2') || '';
    const existingCredentials = await getExistingCredentials(this.userId);

    if (existingCredentials) {
      this.client.deviceId = existingCredentials.device_id;
      this.client.setAccessToken(existingCredentials.access_token);
      this.client.credentials = { userId: this.client.getUserId() };
      return true;
    }

    return false;
  }

  private async setupCrypto(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not created');
    }

    this.cryptoManager = new CryptoManager(this.client);

    const cryptoStatus = await this.cryptoManager.isCryptoReady();

    // initialize crypto if not fully ready
    if (!cryptoStatus.crossSigningReady || !cryptoStatus.secretStorageReady) {
      try {
        await this.cryptoManager.initializeCrypto({
          password: this.authConfig.password,
          setupCrossSigning: true,
          setupSecretStorage: true,
          authConfig: this.authConfig
        });
      } catch (error) {
        console.error('Failed to initialize crypto:', error);
        throw error;
      }
    }

    // ensure key backup is set up
    const cryptoApi = this.client.getCrypto();
    if (cryptoApi) {
      const keyBackupInfo = await cryptoApi.checkKeyBackupAndEnable();

      if (!keyBackupInfo) {
        await cryptoApi.resetKeyBackup();
      }

      // event listener for key backup status (optional)
      this.client.on(MatrixSDK.Crypto.CryptoEvent.KeyBackupStatus, async (status) => {
        try {
          await setKeyBackupStatus(status);
        } catch (error) {
          console.error('Failed to update key backup status:', error);
        }
      });
    }
  }

  public async getCryptoStatus() {
    if (!this.cryptoManager) {
      return null;
    }
    return this.cryptoManager.isCryptoReady();
  }

  public async exportEncryptionKeys() {
    if (!this.cryptoManager) {
      throw new Error('Crypto manager not initialized');
    }
    return this.cryptoManager.exportKeys();
  }

  public async importEncryptionKeys(keys: {
    roomKeys: string;
    secretsBundle?: any;
  }) {
    if (!this.cryptoManager) {
      throw new Error('Crypto manager not initialized');
    }
    await this.cryptoManager.importKeys(keys);
  }

  private async setupEventListeners(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not created');
    }

    this.client.on(MatrixSDK.RoomEvent.Timeline, async  (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) {
        return; // don't retrieve paginated results
      }

      if (event.getType() === "m.room.message") {
        await persistMessage(room?.roomId, event); // handles message decryption internally if needed
      }
    });

    this.client.on(MatrixSDK.RoomEvent.Summary, async  (_summary: MatrixSDK.IRoomSummary) => {
      // TODO: handle participants
    });

    this.client.on(MatrixSDK.RoomEvent.MyMembership, async  (_room: MatrixSDK.Room, _membership, _prevMembership) => {
      // TODO: handle rooms
    });
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

  public async logout(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not created');
    }

    try {
      // TODO: a way to stop the crypto backend during logout

      const syncToken = await this.client.store.getSavedSyncToken();

      await this.client.logout();
      this.client.stopClient();

      // reset crypto-related state
      this.cryptoManager = null;

      await updateSyncToken(syncToken ?? "");

      console.log('Successfully logged out and stopped crypto backend.');
    } catch (error: any) {
      console.error('Failed to logout:', error);
      throw new Error(`Logout failed: ${error.message}`);
    } finally {
      this.isInitialized = false;
    }
  }

  public getClient(): MatrixSDK.MatrixClient | null {
    return this.client;
  }
}
