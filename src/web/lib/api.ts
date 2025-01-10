import { MatrixConfig, SyncStatus } from '../../types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

class APIClient {
private static async request<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'API request failed');
    }

    return response.json();
}

static async login(config: MatrixConfig): Promise<{ success: boolean }> {
    return this.request('/auth/login', {
        method: 'POST',
        body: JSON.stringify(config),
    });
}

static async getSyncStatus(): Promise<SyncStatus> {
    return this.request('/sync/status');
}

static async getStats(): Promise<{
    totalRooms: number;
    totalMessages: number;
    lastSync: string;
}> {
    return this.request('/stats');
}

static async restartSync(): Promise<{ success: boolean }> {
    return this.request('/sync/restart', { method: 'POST' });
}

static async exportE2EKeys(): Promise<{ keys: string }> {
    return this.request('/crypto/export', { method: 'POST' });
}

static async importE2EKeys(keys: string): Promise<{ success: boolean }> {
    return this.request('/crypto/import', {
        method: 'POST',
        body: JSON.stringify({ keys }),
    });
    }
}

export default APIClient;
