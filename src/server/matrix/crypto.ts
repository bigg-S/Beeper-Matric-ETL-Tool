import * as MatrixSDK from 'matrix-js-sdk';
import { OlmMachine, UserId, DeviceId, RoomId } from '@matrix-org/matrix-sdk-crypto-nodejs';
import * as fs from 'fs';
import { ISigned } from 'matrix-js-sdk/lib/@types/signed';

interface CryptoStatus {
    initialized: boolean;
    backupStatus: {
        enabled: boolean;
        lastBackup: string | null;
        version: string | null;
        algorithm: string | null
        auth_data: ISigned & (MatrixSDK.Crypto.Curve25519AuthData | MatrixSDK.Crypto.Aes256AuthData) | null
    };
    keysStatus: {
        totalKeys: number;
        backedUpKeys: number;
    };
}

interface ISecretStorageKeyInfo {
    passphrase?: {
        algorithm: string;
        salt: string;
        iterations: number;
    };
}

export class CryptoManager {
    private crypto: OlmMachine | null = null;
    private client: MatrixSDK.MatrixClient | null = null;
    private storePath: string;
    private status: CryptoStatus;
    private backupKey: Uint8Array | null = null;

    constructor(storePath: string = process.env.CRYPTO_STORE_PATH || './crypto-store') {
        this.storePath = storePath;
        this.ensureStorePathExists();
        this.status = {
            initialized: false,
            backupStatus: {
                enabled: false,
                lastBackup: null,
                version: null,
                algorithm: null,
                auth_data: null
            },
            keysStatus: {
                totalKeys: 0,
                backedUpKeys: 0
            }
        };
    }

    private ensureStorePathExists() {
        if (!fs.existsSync(this.storePath)) {
            fs.mkdirSync(this.storePath, { recursive: true });
        }
    }

    private async deriveKey(passphrase: string, salt: string, iterations: number): Promise<Uint8Array> {
        const encoder = new TextEncoder();
        const baseKey = await crypto.subtle.importKey(
            'raw',
            encoder.encode(passphrase),
            'PBKDF2',
            false,
            ['deriveBits']
        );

        const derivedBits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: encoder.encode(salt),
                iterations: iterations,
                hash: 'SHA-512'
            },
            baseKey,
            256
        );

        return new Uint8Array(derivedBits);
    }

    private getSecretStorageKey = async ({
        keys: keyInfos,
    }: {
        keys: Record<string, ISecretStorageKeyInfo>;
    }): Promise<[string, Uint8Array] | null> => {
        if (!this.backupKey) return null;

        const keyId = await this.client?.secretStorage.getDefaultKeyId();
        if (!keyId || !keyInfos[keyId]) return null;

        const keyInfo = keyInfos[keyId];
        if (!keyInfo.passphrase) return null;

        const derivedKey = await this.deriveKey(
            this.backupKey.toString(),
            keyInfo.passphrase.salt,
            keyInfo.passphrase.iterations
        );

        return [keyId, derivedKey];
    };

    async initCrypto(client: MatrixSDK.MatrixClient, passphrase?: string): Promise<void> {
        try {
            const userId = new UserId(client.getUserId() || '');
            const deviceId = new DeviceId(client.getDeviceId() || '');

            if (!userId || !deviceId) {
                throw new Error("Invalid User ID or Device ID");
            }

            this.client = client;
            this.crypto = await OlmMachine.initialize(userId, deviceId, this.storePath);

            // Set up crypto callbacks
            client.cryptoCallbacks = {
                getSecretStorageKey: this.getSecretStorageKey.bind(this)
            };

            // Set up device verification handling
            client.on(
                MatrixSDK.Crypto.CryptoEvent.VerificationRequestReceived,
                (request) => {
                    const otherUserId = request.otherUserId;
                    const otherDeviceId = request.otherDeviceId;

                    if (otherUserId && otherDeviceId) {
                        this.handleDeviceVerificationChanged(otherUserId, otherDeviceId, request);
                    } else {
                        console.warn("Verification request received without other user/device ID", request);
                    }
                }
            );

            if (passphrase) {
                const encoder = new TextEncoder();
                this.backupKey = encoder.encode(passphrase);
            }

            // Check existing backup
            await this.checkAndRestoreBackup();

            this.status.initialized = true;

        } catch (error: any) {
            console.error('Failed to initialize crypto:', error);
            throw new Error(`Crypto initialization failed: ${error.message}`);
        }
    }

    private async checkAndRestoreBackup(): Promise<void> {
        if (!this.client) return;

        try {
            const backup = await this.client.getCrypto()?.checkKeyBackupAndEnable();

            if (backup?.backupInfo) {
                this.status.backupStatus.version = backup.backupInfo.version ?? null;

                if (backup.backupInfo.auth_data?.private_key_salt &&
                    backup.backupInfo.auth_data?.private_key_iterations &&
                    this.backupKey) {

                    await this.client.getCrypto()?.restoreKeyBackupWithPassphrase(this.backupKey.toString());
                } else {
                    await this.client.getCrypto()?.checkKeyBackupAndEnable();

                    if (!backup.trustInfo.trusted) {
                        await this.client.getCrypto()?.restoreKeyBackup();
                    }
                }

                this.status.backupStatus.enabled = true;
            }
        } catch (error) {
            console.error('Failed to check/restore backup:', error);
        }
    }

    async createBackup(passphrase: string): Promise<void> {
        if (!this.client) {
            throw new Error('Client not initialized');
        }

        try {
            const encoder = new TextEncoder();
            this.backupKey = encoder.encode(passphrase);

            await this.client.getCrypto()?.resetKeyBackup();

            const backupInfo = await this.client.getCrypto()?.getKeyBackupInfo();

            if (backupInfo) {
                this.status.backupStatus = {
                    version: backupInfo?.version ?? null,
                    algorithm: backupInfo?.algorithm ?? null,
                    auth_data: backupInfo?.auth_data,
                    enabled: true,
                    lastBackup: new Date().toString(),
                };
            } else {
                this.status.backupStatus = {
                    version: "No Backup",
                    algorithm: null,
                    auth_data: null,
                    enabled: false,
                    lastBackup: null,
                };
            }
            this.status.backupStatus.enabled = true;
            this.status.backupStatus.lastBackup = new Date().toISOString();

        } catch (error) {
            console.error('Failed to create backup:', error);
            throw error;
        }
    }

    private async handleDeviceVerificationChanged(userId: string, deviceId: string, request: MatrixSDK.Crypto.VerificationRequest): Promise<void> {
        try {
            if (this.crypto) {
                console.log(`Device verification changed for user: ${userId}, device: ${deviceId}`);
                request.startVerification("m.sas.v1");
                // TODO: impl appropriate handle logic
            } else {
                console.warn('Crypto not initialized, unable to handle device verification change.');
            }
        } catch (error) {
            console.error('Failed to update device trust:', error);
        }
    }


    async encryptEvent(roomId: string, eventType: string, content: any): Promise<any> {
        if (!this.crypto) {
            throw new Error('Crypto is not initialized');
        }

        try {
            return await this.crypto.encryptRoomEvent(
                new RoomId(roomId),
                eventType,
                content
            );
        } catch (error) {
            console.error(`Failed to encrypt event for room ${roomId}:`, error);
            throw error;
        }
    }

    async decryptEvent(event: MatrixSDK.MatrixEvent): Promise<any> {
        if (!this.crypto) {
            throw new Error('Crypto is not initialized');
        }

        const eventId = event.getId();
        const roomId = event.getRoomId();

        if (!eventId || !roomId) {
            throw new Error('Invalid event or room ID');
        }

        try {
            return await this.crypto.decryptRoomEvent(eventId, new RoomId(roomId));
        } catch (error) {
            console.error(`Failed to decrypt event ${eventId}:`, error);
            throw error;
        }
    }

    getStatus(): CryptoStatus {
        return this.status;
    }
}

export const cryptoManager = new CryptoManager();

export const initCrypto = async (client: MatrixSDK.MatrixClient): Promise<void> => {
    await cryptoManager.initCrypto(client);
};
