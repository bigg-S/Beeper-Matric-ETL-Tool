import * as MatrixSDK from 'matrix-js-sdk';
import { OlmMachine, UserId, DeviceId, RoomId } from '@matrix-org/matrix-sdk-crypto-nodejs';
import * as path from 'path';
import * as fs from 'fs';

export class CryptoManager {
    private crypto: OlmMachine | null = null;
    private storePath: string;

    constructor(storePath: string = process.env.CRYPTO_STORE_PATH || './crypto-store') {
        this.storePath = storePath;
        this.ensureStorePathExists();
    }

    private ensureStorePathExists() {
        if (!fs.existsSync(this.storePath)) {
            fs.mkdirSync(this.storePath, { recursive: true });
        }
    }

    async initCrypto(client: MatrixSDK.MatrixClient): Promise<void> {
        try {
            const user_id = client.getUserId();
            const device_id = client.getDeviceId();

            if (!user_id || !device_id) {
                throw(Error("invalida User Id or device Id"));
            }

            const userId = new UserId(user_id);
            const deviceId = new DeviceId(device_id);
            this.crypto = await OlmMachine.initialize(userId, deviceId);

            // up crypto callbacks
            client.onDeviceVerification = async (userId: string, deviceId: string, verified: boolean) => {
                console.log(`Device verification changed for ${userId}:${deviceId} - verified: ${verified}`);
            };

            client.onSecretRequested = async (request: any) => {
                // Handle secret requests for cross-signing
                return null;
            };

            client.onSecretReceived = async (secret: any) => {
                // Handle received secrets
            };

            client.setGlobalErrorOnUnknownDevices(false);

        } catch (error: any) {
            console.error('Failed to initialize crypto:', error);
            throw new Error(`Crypto initialization failed: ${error.message}`);
        }
    }

    async encryptEvent(roomId: RoomId, eventType: string, content: any): Promise<any> {
        if (!this.crypto) {
            throw new Error('Crypto is not initialized');
        }

        try {
            return await this.crypto.encryptRoomEvent(roomId, eventType, content);
        } catch (error) {
            console.error(`Failed to encrypt event for room ${roomId}:`, error);
            throw error;
        }
    }

    async decryptEvent(event: MatrixSDK.MatrixEvent, roomId: RoomId): Promise<any> {
        if (!this.crypto) {
            throw new Error('Crypto is not initialized');
        }

        const eventId = event.getId();

        if (!eventId) {
            throw new Error('Event ID is undefined, cannot decrypt event.');
        }

        try {
            return await this.crypto.decryptRoomEvent(eventId, roomId);
        } catch (error) {
            console.error(`Failed to decrypt event ${event.getId()}:`, error);
            throw error;
        }
    }

    async exportE2EKeys(): Promise<string> {
        if (!this.crypto) {
            throw new Error('Crypto is not initialized');
        }

        try {
            return await this.crypto.export();
        } catch (error) {
            console.error('Failed to export E2E keys:', error);
            throw error;
        }
    }

    async importE2EKeys(keys: string): Promise<void> {
        if (!this.crypto) {
            throw new Error('Crypto is not initialized');
        }

        try {
            await this.crypto.import(keys);
        } catch (error) {
            console.error('Failed to import E2E keys:', error);
            throw error;
        }
    }

    // backup the E2E keys to a file
    async backupKeys(): Promise<void> {
        try {
            const keys = await this.exportE2EKeys();

            const backupFilePath = path.join(this.storePath, 'e2e_keys_backup.json');
            fs.writeFileSync(backupFilePath, keys, { encoding: 'utf-8' });
            console.log('E2E keys successfully backed up');
        } catch (error) {
            console.error('Failed to backup E2E keys:', error);
            throw error;
        }
    }

    // restore the E2E keys from a backup file
    async restoreKeys(): Promise<void> {
        try {
            const backupFilePath = path.join(this.storePath, 'e2e_keys_backup.json');

            if (!fs.existsSync(backupFilePath)) {
                throw new Error('Backup file does not exist');
            }

            const keys = fs.readFileSync(backupFilePath, { encoding: 'utf-8' });

            await this.importE2EKeys(keys);
            console.log('E2E keys successfully restored');
        } catch (error) {
            console.error('Failed to restore E2E keys:', error);
            throw error;
        }
    }

    // the current status of the encryption system
    getStatus(): string {
        try {
            if (!this.crypto) {
                return 'Crypto system is not initialized';
            }

            return 'Crypto system is fully operational';
        } catch (error) {
            console.error('Failed to get crypto status:', error);
            return 'Error retrieving crypto status';
        }
    }
}

export const cryptoManager = new CryptoManager();

export const initCrypto = async (client: MatrixSDK.MatrixClient): Promise<void> => {
    await cryptoManager.initCrypto(client);
};
