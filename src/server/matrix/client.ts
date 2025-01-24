import * as MatrixSDK from 'matrix-js-sdk';
import { EventEmitter } from 'events';
import * as dotenv from 'dotenv';
import { UserPayload } from '../types';
import { cryptoManager } from './crypto';
import { getExistingCredentials, setAuthCredentials, setKeyBackupStatus } from './utils/db.utils';
import { syncManager } from './sync';

dotenv.config();

export class MatrixClient extends EventEmitter {
  private client: MatrixSDK.MatrixClient | null | undefined;
  private authConfig: UserPayload;
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
        userId: `@${this.authConfig.username}:${this.authConfig.domain}`
      });

      await this.login();

      await this.setupCrypto();

      await this.setupSync();

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
      const existingCredentials = await getExistingCredentials(this.userId);

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

      await setAuthCredentials(this.client, loginResponse, this.authConfig)

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
      await setKeyBackupStatus(status);
    });
  }

  private async setupSync() {
    if (!this.client) {
      throw new Error("Client not created");
    }

    syncManager.initialize(this.client);

  }

  public getClient() {
    return this.client;
  }
}
