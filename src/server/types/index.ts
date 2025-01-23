import { ISigned } from "matrix-js-sdk/lib/@types/signed";
import * as sdk from "matrix-js-sdk"
import { KeyExportOptions, KeyFormat } from "crypto";

export interface UserPayload {
    username: string;
    password: string;
    domain: string;
}

export interface Room {
    id: string;
    name: string;
    topic?: string;
    encrypted: boolean;
    members: string[];
}

export interface Message {
    id: string;
    roomId: string;
    sender: string;
    content: string;
    timestamp: Date;
    encrypted: boolean;
}

declare global {
    namespace Express {
        interface Request {
            user?: UserPayload;
        }
    }
}

// Auth:

export interface BeeperAuthConfig {
    username: string;
    password: string;
    domain: string;
    deviceId?: string;
}



// Crypto:

export interface CryptoStatus {
    initialized: boolean;
    backupStatus: {
        enabled: boolean;
        lastBackup: string | null;
        version: string | null;
        algorithm: string | null
        auth_data: ISigned & (sdk.Crypto.Curve25519AuthData | sdk.Crypto.Aes256AuthData) | null
    };
    keysStatus: {
        lastImport: string;
        exportedAt: string;
        totalKeys: number;
        backedUpKeys: number;
    };
}

export interface ISecretStorageKeyInfo {
    passphrase?: {
        algorithm: string;
        salt: string;
        iterations: number;
    };
}

export interface EncryptedData {
    iv: string;
    data: string;
    salt: string;
    iterations: number;
    version: string;
    algorithm: string;
}

type CustomKeyFormat = 'pkcs8' | 'spki' | 'pkcs1' | 'sec1' | 'file' | 'json';

export interface KeyExportOptionsCustom extends Omit<KeyExportOptions<KeyFormat>, 'format'> {
    roomKeys?: boolean;
    megolmKeys?: boolean;
    olmKeys?: boolean;
    format: CustomKeyFormat;
    password?: string;
    iterations?: number;
}


export class CryptoError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
        this.name = 'CryptoError';
    }
}



// Sync:
export interface SyncStatus {
    state: 'initializing' | 'syncing' | 'error' | 'stopped';
    lastSync?: Date;
    error?: string;
}

export interface ParticipantData {
    user_id: string;
    display_name: string;
    avatar_url?: string;
    membership: string;
    room_id: string;
    joined_ts?: number;
    last_updated: string;
}

export interface RoomData {
    id: string;
    name: string;
    topic: string;
    is_encrypted: boolean;
    created_ts?: number;
    avatar_url?: string;
    last_updated: string;
}

export interface SyncProgress {
    totalRooms: number;
    processedRooms: number;
    totalMessages: number;
    processedMessages: number;
    totalParticipants: number;
    processedParticipants: number;
    currentPhase: 'initializing' | 'keys' | 'rooms' | 'messages' | 'participants' | 'incremental' | 'error';
    error?: string;
}

export interface SyncManagerOptions {
    maxTimelineEntries: number;
    batchSize?: number;
    initialSyncLimit?: number;
    timeoutMs?: number;
}

export interface StoredSyncData {
    nextBatch: string;
    syncData: sdk.ISyncData;
}
