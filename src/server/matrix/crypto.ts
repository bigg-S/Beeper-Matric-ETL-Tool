import * as MatrixSDK from 'matrix-js-sdk';
import { OlmMachine, UserId, DeviceId, RoomId } from '@matrix-org/matrix-sdk-crypto-nodejs';
import * as fs from 'fs';
import { CryptoStatus, EncryptedData, ISecretStorageKeyInfo, KeyExportOptionsCustom } from '@/types';
import { DeviceVerificationStatus } from 'matrix-js-sdk/lib/crypto-api';


class CryptoError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'CryptoError';
    }
}

export class CryptoManager {
    private static readonly ENCRYPTION_VERSION = '1.0.0';
    private static readonly MIN_PASSWORD_LENGTH = 8;
    private static readonly DEFAULT_ITERATIONS = 310000; // OWASP
    private static readonly SALT_LENGTH = 32;
    private static readonly KEY_LENGTH = 32;
    private static readonly IV_LENGTH = 12;
    private static readonly TAG_LENGTH = 16;
    private static readonly ALGORITHM = 'aes-256-gcm';

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
                backedUpKeys: 0,
                exportedAt: "",
                lastImport: ""
            }
        };
    }

    private ensureStorePathExists() {
        if (!fs.existsSync(this.storePath)) {
            fs.mkdirSync(this.storePath, { recursive: true });
        }
    }

    private async deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<{key: CryptoKey; rawKey: Uint8Array}> {
        if (passphrase.length < CryptoManager.MIN_PASSWORD_LENGTH) {
            throw new CryptoError(
                `Password must be at least ${CryptoManager.MIN_PASSWORD_LENGTH} characters long`,
                'INVALID_PASSWORD_LENGTH'
            );
        }

        try {
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
                    salt,
                    iterations,
                    hash: 'SHA-512'
                },
                baseKey,
                CryptoManager.KEY_LENGTH * 8
            );

            const key = await crypto.subtle.importKey(
                'raw',
                derivedBits,
                'AES-GCM',
                false,
                ['encrypt', 'decrypt']
            );

            return { key, rawKey: new Uint8Array(derivedBits) };
        } catch (error) {
            throw new CryptoError(
                `Failed to generate encryption key: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'KEY_GENERATION_FAILED'
            );
        }
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

        const salt = Uint8Array.from(keyInfo.passphrase.salt)

        const derivedKey = await this.deriveKey(
            this.backupKey.toString(),
            salt,
            keyInfo.passphrase.iterations
        );

        return [keyId, derivedKey.rawKey];
    };

    async initCrypto(client: MatrixSDK.MatrixClient, passphrase?: string): Promise<void> {
        try {
            const userId = new UserId(client.getUserId() || '');
            const deviceId = new DeviceId(client.getDeviceId() || '');

            if (!userId || !deviceId) {
                throw new Error("Invalid User ID or Device ID");
            }

            this.client = client;
            this.crypto = await OlmMachine.initialize(userId, deviceId, this.storePath, passphrase);

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

    private async encryptData(data: string, key: CryptoKey): Promise<{ encryptedData: ArrayBuffer; iv: Uint8Array }> {
        try {
            const encoder = new TextEncoder();
            const iv = crypto.getRandomValues(new Uint8Array(CryptoManager.IV_LENGTH));

            const encryptedData = await crypto.subtle.encrypt(
                {
                    name: 'AES-GCM',
                    iv,
                    tagLength: CryptoManager.TAG_LENGTH * 8
                },
                key,
                encoder.encode(data)
            );

            return { encryptedData, iv };
        } catch (error) {
            throw new CryptoError(
                `Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'ENCRYPTION_FAILED'
            );
        }
    }

    private async decryptData(
        encryptedData: ArrayBuffer,
        key: CryptoKey,
        iv: Uint8Array
    ): Promise<string> {
        try {
            const decryptedData = await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv,
                    tagLength: CryptoManager.TAG_LENGTH * 8
                },
                key,
                encryptedData
            );

            return new TextDecoder().decode(decryptedData);
        } catch (error) {
            throw new CryptoError(
                `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'DECRYPTION_FAILED'
            );
        }
    }

    async exportKeys(options: KeyExportOptionsCustom): Promise<string | void> {
        if (!this.client?.getCrypto()) {
            throw new CryptoError('Crypto is not initialized', 'CRYPTO_NOT_INITIALIZED');
        }

        try {
            const defaultOptions = {
                roomKeys: true,
                megolmKeys: true,
                olmKeys: true,
                format: 'json',
                password: undefined,
                iterations: CryptoManager.DEFAULT_ITERATIONS
            };

            const finalOptions = { ...defaultOptions, ...options };

            // Export keys using Matrix SDK
            const exported = await this.client.getCrypto()?.exportRoomKeys();

            if (!exported || !Array.isArray(exported)) {
                throw new CryptoError('Failed to export keys: Invalid export format', 'INVALID_EXPORT_FORMAT');
            }

            let result: string | EncryptedData;

            if (finalOptions.password) {
                // generate salt and encryption parameters
                const salt = crypto.getRandomValues(new Uint8Array(CryptoManager.SALT_LENGTH));

                // encryption key
                const { key } = await this.deriveKey(
                    finalOptions.password,
                    salt,
                    finalOptions.iterations
                );

                // Encrypt the data
                const { encryptedData, iv } = await this.encryptData(JSON.stringify(exported), key);

                // Format the encrypted data
                result = {
                    iv: Buffer.from(iv).toString('base64'),
                    data: Buffer.from(encryptedData).toString('base64'),
                    salt: Buffer.from(salt).toString('base64'),
                    iterations: finalOptions.iterations,
                    version: CryptoManager.ENCRYPTION_VERSION,
                    algorithm: CryptoManager.ALGORITHM
                };
            } else {
                result = JSON.stringify(exported);
            }

            if (finalOptions.format === 'file') {
                const filename = `matrix-keys-${Date.now()}.txt`;
                fs.writeFileSync(filename, typeof result === 'string' ? result : JSON.stringify(result));
                this.status.keysStatus.exportedAt = new Date().toISOString();
                return filename;
            }

            this.status.keysStatus.exportedAt = new Date().toISOString();
            return typeof result === 'string' ? result : JSON.stringify(result);

        } catch (error) {
            if (error instanceof CryptoError) {
                throw error;
            }
            throw new CryptoError(
                `Failed to export keys: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'EXPORT_FAILED'
            );
        }
    }

    async importKeys(keyData: string, password?: string): Promise<void> {
        if (!this.client?.getCrypto()) {
            throw new CryptoError('Crypto is not initialized', 'CRYPTO_NOT_INITIALIZED');
        }

        try {
            let parsedData: any;
            try {
                parsedData = JSON.parse(keyData);
            } catch (error) {
                throw new CryptoError('Invalid key data format', 'INVALID_KEY_DATA');
            }

            let decryptedKeys: any;

            if (parsedData.version && parsedData.algorithm === CryptoManager.ALGORITHM) {
                if (!password) {
                    throw new CryptoError('Password required for encrypted keys', 'PASSWORD_REQUIRED');
                }

                if (!parsedData.iv || !parsedData.data || !parsedData.salt || !parsedData.iterations) {
                    throw new CryptoError('Invalid encrypted data format', 'INVALID_ENCRYPTED_DATA');
                }

                // base64 data back to buffers
                const iv = Buffer.from(parsedData.iv, 'base64');
                const encryptedData = Buffer.from(parsedData.data, 'base64');
                const salt = Buffer.from(parsedData.salt, 'base64');

                const { key } = await this.deriveKey(
                    password,
                    new Uint8Array(salt),
                    parsedData.iterations
                );

                const decryptedData = await this.decryptData(
                    encryptedData.buffer,
                    key,
                    new Uint8Array(iv)
                );

                try {
                    decryptedKeys = JSON.parse(decryptedData);
                } catch (error) {
                    throw new CryptoError('Failed to parse decrypted data', 'INVALID_DECRYPTED_DATA');
                }
            } else {
                decryptedKeys = parsedData;
            }

            if (!Array.isArray(decryptedKeys)) {
                throw new CryptoError('Invalid key data structure', 'INVALID_KEY_STRUCTURE');
            }

            await this.client.getCrypto()?.importRoomKeys(decryptedKeys);

            this.status.keysStatus.lastImport = new Date().toISOString();
            this.status.keysStatus.totalKeys = decryptedKeys.length;
            this.status.keysStatus.backedUpKeys = decryptedKeys.length;

        } catch (error) {
            if (error instanceof CryptoError) {
                throw error;
            }
            throw new CryptoError(
                `Failed to import keys: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'IMPORT_FAILED'
            );
        }
    }

    async recoverKeys(passphrase?: string): Promise<void> {
        if (!this.client?.getCrypto()) {
            throw new CryptoError('Crypto is not initialized', 'CRYPTO_NOT_INITIALIZED');
        }

        try {
            // check existing backup
            const backup = await this.client.getCrypto()?.checkKeyBackupAndEnable();

            if (!backup?.backupInfo) {
                throw new CryptoError('No backup found to recover', 'NO_BACKUP_FOUND');
            }

            // backup recovery based on authentication data presence
            if (backup.backupInfo.auth_data?.private_key_salt &&
                backup.backupInfo.auth_data?.private_key_iterations) {

                if (!passphrase) {
                    throw new CryptoError('Passphrase required for encrypted backup', 'PASSPHRASE_REQUIRED');
                }

                // restore using password-based method
                await this.client.getCrypto()?.restoreKeyBackupWithPassphrase(passphrase);
            } else {
                // Enable backup and attempt recovery using secret storage
                try {
                    await this.client.getCrypto()?.checkKeyBackupAndEnable();

                    if (!backup.trustInfo.trusted) {
                        await this.client.restoreKeyBackupWithSecretStorage(
                            backup.backupInfo,
                            undefined,
                            undefined
                        );
                    }
                } catch (error) {
                    throw new CryptoError(
                        `Failed to restore from secret storage: ${error instanceof Error ? error.message : 'Unknown error'}`,
                        'SECRET_STORAGE_RESTORE_FAILED'
                    );
                }
            }

            // update backup status after recovery
            this.status.backupStatus = {
                version: backup.backupInfo.version ?? null,
                algorithm: backup.backupInfo.algorithm ?? null,
                auth_data: backup.backupInfo.auth_data,
                enabled: true,
                lastBackup: new Date().toISOString()
            };

            // const keyStatus = await this.client.getCrypto()?.getSessionBackupPrivateKey();
            // if (keyStatus) {
            //     const sessions = await this.client.getK;
            //     if (sessions) {
            //         this.status.keysStatus.totalKeys = sessions.total || 0;
            //         this.status.keysStatus.backedUpKeys = sessions.backed_up || 0;
            //     }
            // }

        } catch (error) {
            console.error('Failed to recover keys:', error);
            if (error instanceof CryptoError) {
                throw error;
            }
            throw new CryptoError(
                `Key recovery failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                'RECOVERY_FAILED'
            );
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

    async getDetailedStatus(): Promise<CryptoStatus & {
        deviceVerification: {
            status: DeviceVerificationStatus | null
        };
        crossSigning: {
            enabled: boolean;
            trusted: boolean;
        };
    }> {
        const basicStatus = this.getStatus();
        const crypto = this.client?.getCrypto();

        if (!crypto) {
            return {
                ...basicStatus,
                deviceVerification: {
                    status: null
                },
                crossSigning: {
                    enabled: false,
                    trusted: false,
                },
            };
        }

        const crossSigningStatus = await crypto.getCrossSigningStatus();

        return {
            ...basicStatus,
            deviceVerification: {
                status: await crypto.getDeviceVerificationStatus(this.client?.getUserId() ?? "", this.client?.deviceId ?? "")
            },
            crossSigning: {
                enabled: crossSigningStatus.publicKeysOnDevice,
                trusted: crossSigningStatus.privateKeysInSecretStorage,
            },
        };
    }
}

export const cryptoManager = new CryptoManager();

export const initCrypto = async (client: MatrixSDK.MatrixClient): Promise<void> => {
    await cryptoManager.initCrypto(client);
};
