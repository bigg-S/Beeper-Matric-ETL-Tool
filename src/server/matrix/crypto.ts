import * as sdk from 'matrix-js-sdk';
import { MatrixCryptoApi } from '@matrix-org/matrix-sdk-crypto-nodejs';
import * as path from 'path';
import * as fs from 'fs';

export class CryptoManager {
private crypto: MatrixCryptoApi;
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

async initCrypto(client: sdk.MatrixClient): Promise<void> {
    try {
        this.crypto = new MatrixCryptoApi({
            userId: client.getUserId(),
            deviceId: client.getDeviceId(),
            storePath: path.resolve(this.storePath),
        });

        await this.crypto.initialize();

        // Set up crypto callbacks
        client.setCryptoCallbacks({
            async onDeviceVerification(userId: string, deviceId: string, verified: boolean) {
            console.log(`Device verification changed for ${userId}:${deviceId} - verified: ${verified}`);
            },

            async onSecretRequested(request: any) {
            // Handle secret requests for cross-signing
            return null;
            },

            async onSecretReceived(secret: any) {
            // Handle received secrets
            },
        });

        // Enable encryption for new rooms by default
        client.setGlobalErrorOnUnknownDevices(false);

    } catch (error) {
        console.error('Failed to initialize crypto:', error);
        throw new Error(`Crypto initialization failed: ${error.message}`);
    }
}

async encryptEvent(roomId: string, eventType: string, content: any): Promise<any> {
    try {
        return await this.crypto.encryptRoomEvent(roomId, eventType, content);
    } catch (error) {
        console.error(`Failed to encrypt event for room ${roomId}:`, error);
        throw error;
    }
}

async decryptEvent(event: sdk.MatrixEvent): Promise<any> {
    try {
        return await this.crypto.decryptRoomEvent(event);
    } catch (error) {
        console.error(`Failed to decrypt event ${event.getId()}:`, error);
        throw error;
    }
}

async exportE2EKeys(): Promise<string> {
    try {
        return await this.crypto.export();
    } catch (error) {
        console.error('Failed to export E2E keys:', error);
        throw error;
    }
}

async importE2EKeys(keys: string): Promise<void> {
        try {
            await this.crypto.import(keys);
        } catch (error) {
            console.error('Failed to import E2E keys:', error);
            throw error;
        }
    }
}

export const cryptoManager = new CryptoManager();

export const initCrypto = async (client: sdk.MatrixClient): Promise<void> => {
    await cryptoManager.initCrypto(client);
};
