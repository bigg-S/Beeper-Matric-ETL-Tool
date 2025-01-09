export interface MatrixConfig {
    username: string;
    password: string;
    domain: string;
}

export interface SyncStatus {
    state: 'initializing' | 'syncing' | 'synchronized' | 'error';
    progress?: number;
    lastSync?: Date;
    error?: string;
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
