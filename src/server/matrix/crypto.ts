import { AuthDict, Device, MatrixClient } from 'matrix-js-sdk';
import { UserPayload } from '../types';

export interface CryptoSetupStatus {
  crossSigningReady: boolean;
  secretStorageReady: boolean;
  keyBackupAvailable: boolean;
  deviceVerified: boolean;
}

export class CryptoManager {
  private client: MatrixClient;

  constructor(client: MatrixClient) {
    this.client = client;
  }


  async isCryptoReady(): Promise<CryptoSetupStatus> {
    try {
      const userId = this.client.getUserId() ?? "";
      const [
        crossSigningReady,
        secretStorageReady,
        keyBackupInfo,
        ownDevices
      ] = await Promise.all([
        this.client.getCrypto()?.isCrossSigningReady(),
        this.client.getCrypto()?.isSecretStorageReady(),
        this.client.getCrypto()?.getKeyBackupInfo(),
        this.client.getCrypto()?.getUserDeviceInfo([userId], true)
      ]);

      let isVerified = false;
      if (ownDevices && ownDevices.has(userId)) {
        const deviceMap = ownDevices.get(userId)!; // the inner map
        // iterating over the deviceMap to find a verified device.
        for (const device of deviceMap.values()) {
            if(this.isDeviceVerified(device)){
                isVerified = true
                break;
            }
        }
      }

      return {
        crossSigningReady: !!crossSigningReady,
        secretStorageReady: !!secretStorageReady,
        keyBackupAvailable: !!keyBackupInfo,
        deviceVerified: isVerified
      };
    } catch (error) {
      console.error('Error checking crypto readiness:', error);
      return {
        crossSigningReady: false,
        secretStorageReady: false,
        keyBackupAvailable: false,
        deviceVerified: false
      };
    }
  }

  async initializeCrypto(opts?: {
    password?: string;
    setupCrossSigning?: boolean;
    setupSecretStorage?: boolean;
    authConfig?: UserPayload;
  }): Promise<CryptoSetupStatus> {
    const crypto = this.client.getCrypto();
    if (!crypto) {
      throw new Error('Crypto not initialized');
    }

    try {
      // bootstrap cross-signing if requested
      if (opts?.setupCrossSigning) {
        await crypto.bootstrapCrossSigning({
          authUploadDeviceSigningKeys: async (makeRequest) => {
            return makeRequest(opts.authConfig as AuthDict).then(() => {});
          },
        });
      }

      // bootstrap secret storage if requested
      if (opts?.setupSecretStorage) {
        await crypto.bootstrapSecretStorage({
          // create new secret storage key (if needed)
          setupNewSecretStorage: true,
          ...(opts.password ? {
            createSecretStorageKey: async () => {
              return crypto.createRecoveryKeyFromPassphrase(opts.password);
            }
          } : {})
        });
      }

      // verify the current device
      await this.verifyCurrentDevice();

      // return current crypto status
      return this.isCryptoReady();
    } catch (error) {
      console.error('Crypto initialization error:', error);
      throw error;
    }
  }

  private async verifyCurrentDevice(): Promise<void> {
    const crypto = this.client.getCrypto();
    if (!crypto) return;

    try {
      // request verification from other devices
      await crypto.requestOwnUserVerification();

      // cross-sign our own device
      const ownDevices = await crypto.getUserDeviceInfo([this.client.getUserId() ?? ""]);
      const currentDeviceId = this.client.getDeviceId();

      if (currentDeviceId && ownDevices) {
        await crypto.crossSignDevice(currentDeviceId);
      }
    } catch (error) {
      console.warn('Device verification failed:', error);
    }
  }

  private isDeviceVerified(deviceInfo?: Device) {
    return deviceInfo?.verified;
  }

  async exportKeys(): Promise<{
    roomKeys: string;
    secretsBundle?: any;
  }> {
    const crypto = this.client.getCrypto();
    if (!crypto) {
      throw new Error('Crypto not initialized');
    }

    return {
      roomKeys: await crypto.exportRoomKeysAsJson(),
      secretsBundle: await crypto.exportSecretsBundle?.()
    };
  }

  async importKeys(keys: {
    roomKeys: string;
    secretsBundle?: any;
  }): Promise<void> {
    const crypto = this.client.getCrypto();
    if (!crypto) {
      throw new Error('Crypto not initialized');
    }

    await crypto.importRoomKeysAsJson(keys.roomKeys);

    if (keys.secretsBundle && crypto.importSecretsBundle) {
      await crypto.importSecretsBundle(keys.secretsBundle);
    }
  }
}
