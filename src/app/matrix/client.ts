"use client";
import * as MatrixSDK from 'matrix-js-sdk';
import { EventEmitter } from 'events';
import * as dotenv from 'dotenv';
import { UserPayload } from '../../server/types';
import {
  getExistingCredentials,
  loadLatestSyncToken,
  persistMessage,
  persistParticipant,
  persistParticipants,
  persistRoom,
  setAuthCredentials,
  setKeyBackupStatus,
  updateDeviceId,
  updateSyncToken
} from '../../server/utils/db.utils';
import { CryptoManager } from './crypto';
import { ISecretStorageKeyInfo } from 'matrix-js-sdk/lib/crypto/api';

dotenv.config();

const localStorage = window.localStorage;

let indexedDB: IDBFactory;
try {
    indexedDB = window.indexedDB;
} catch {}


export class MatrixClient extends EventEmitter {
  private client: MatrixSDK.MatrixClient | null = null;
  private cryptoManager: CryptoManager | null = null;
  private authConfig: UserPayload;
  private userId: string = '';
  private accessToken: string = '';
  private storageKey: Uint8Array | null = null;
  private isInitialized = false;
  private isInitializing = false;

  constructor(authConfig: UserPayload) {
    super();
    this.authConfig = authConfig;
  }

  private onUnexpectedStoreClose = async (): Promise<void> => {
    if (!this.client) return;
    this.client.stopClient(); // stop the client as the database has failed
    this.client.store.destroy();
  };

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
      const dbName = `matrix-js-sdk:${this.authConfig.username}`;

      this.client = MatrixSDK.createClient({
        baseUrl: this.authConfig.domain,
        userId: `@${this.authConfig.username}:${this.authConfig.domain}`,
        deviceId: this.generateDeviceId(),
        cryptoStore: new MatrixSDK.IndexedDBCryptoStore(indexedDB, dbName),
        cryptoCallbacks: {
          getSecretStorageKey: this.getSecretStorageKey
        }
      });

      if(!this.client.isLoggedIn()) {
        await this.login();
      }

      await this.setupCrypto();
      await this.setupEventListeners();

      if(!this.client.clientRunning) {
        await this.client.startClient({initialSyncLimit: 50, lazyLoadMembers: true})
        await this.initialFetch();
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

      this.storageKey = await this.generateStorageKey();

      this.client.setAccessToken(authResponse.access_token);
      this.client.credentials = { userId: this.userId }

      await setAuthCredentials(this.client, this.storageKey, authResponse, this.authConfig);
      console.log('User logged in and credentials saved.', this.client.deviceId);

      updateDeviceId(this.userId, this.client.deviceId)

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
      this.client.credentials = { userId: this.userId };
      return true;
    }

    return false;
  }

  private async setupCrypto(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not created');
    }

    for (const dbType of ["indexeddb", "memory"]) {
      try {
        const promise = this.client.store.startup();
        console.log("MatrixClient: waiting for MatrixClient store to initialise");
        await promise;
        break;
      } catch (err) {
        if (dbType === "indexeddb") {
          console.error("Error starting matrixclient store - falling back to memory store", err);
          this.client.store = new MatrixSDK.MemoryStore({
            localStorage: localStorage,
          });
        } else {
          console.error("Failed to start memory store!", err);
          throw err;
        }
      }
    }

    this.client.store.on?.("closed", this.onUnexpectedStoreClose);

    this.cryptoManager = new CryptoManager(this.client);

    const cryptoStatus = await this.cryptoManager.isCryptoReady();

    // initialize crypto if not fully ready
    if (!cryptoStatus.crossSigningReady || !cryptoStatus.secretStorageReady) {
      if(!this.storageKey) throw Error("Storage key is null");
      try {
        await this.cryptoManager.initializeCrypto({
          storageKey: this.storageKey,
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

    this.client.on(MatrixSDK.RoomEvent.MyMembership, async (room, membership, _prevMembership) => {
      if (membership === MatrixSDK.KnownMembership.Invite) {
        try {
          await this.client?.joinRoom(room.roomId);
          console.log("Auto-joined %s", room.roomId);
          await persistRoom(room, membership);
        } catch (error) {
          console.error("Error auto-joining room:", error);
        }
      }
    });

    this.client.on(MatrixSDK.RoomEvent.Timeline, async  (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) {
        return; // don't retrieve paginated results
      }

      if (event.getType() === "m.room.message") {
        await persistMessage(room?.roomId, event);
      }
    });

    this.client.on(MatrixSDK.RoomStateEvent.Members, async  (_event, _state, member: MatrixSDK.RoomMember) => {
      await persistParticipant(member)
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

  public async initialFetch(): Promise<void> {
    const latestToken = await loadLatestSyncToken();

    if (!latestToken) {
      for (const room of this.client!.getRooms()) {
        await persistRoom(room, "");

        await persistParticipants(room);
      }
    }
  }

  public generateDeviceId(): string {
    return Array.from(
      { length: 10 },
      () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.charAt(Math.floor(Math.random() * 26))
    ).join('');
  }

  public async logout(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not created');
    }

    try {
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

  async generateStorageKey(): Promise<Uint8Array> {
    try {
      const key = await crypto.subtle.generateKey(
        {
          name: "AES-GCM",
          length: 256,
        },
        true,
        ["encrypt", "decrypt"]
      );

      const rawKey = await crypto.subtle.exportKey("raw", key);
      const keyArray = new Uint8Array(rawKey);

      if (keyArray.length !== 32) {
        throw new Error("Generated key is not 32 bytes long.");
      }

      return keyArray;
    } catch (error) {
      console.error("Error generating storage key:", error);
      throw error;
    }
  }

  private getSecretStorageKey = async ({
    keys: keyInfos,
  }: {
    keys: Record<string, ISecretStorageKeyInfo>;
  }): Promise<[string, Uint8Array] | null> => {
    if (!this.storageKey) return null;

    const keyId = await this.client?.secretStorage.getDefaultKeyId();
    if (!keyId || !keyInfos[keyId]) return null;

    const keyInfo = keyInfos[keyId];
    if (!keyInfo.passphrase) return null;

    const salt = Uint8Array.from(keyInfo.passphrase.salt);

    const derivedKey = await this.cryptoManager?.deriveKey(
      this.storageKey.toString(),
      salt,
      keyInfo.passphrase.iterations
    );

    if(derivedKey == null) throw new Error("derived Key is null");

    return [keyId, derivedKey.rawKey];
  };

  public getClient(): MatrixSDK.MatrixClient | null {
    return this.client;
  }
}
