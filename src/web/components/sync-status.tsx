import { Card, Progress, Text, Chip } from '@nextui-org/react';
import { useEffect, useState } from 'react';
import { SyncStatus } from '../../types';

export const SyncStatusComponent = () => {
    const [status, setStatus] = useState<SyncStatus>({
    state: 'initializing',
    progress: 0,
});

useEffect(() => {
    const fetchStatus = async () => {
        try {
            const response = await fetch('/api/sync/status');
            const data = await response.json();
            setStatus(data);
        } catch (error) {
            console.error('Failed to fetch sync status:', error);
        }
    };

    // Poll for updates every 5 seconds
    const interval = setInterval(fetchStatus, 5000);
    fetchStatus();

    return () => clearInterval(interval);
}, []);

const getStatusColor = () => {
    switch (status.state) {
        case 'synchronized':
            return 'success';
        case 'error':
            return 'danger';
        case 'syncing':
            return 'primary';
        default:
            return 'warning';
    }
};

const formatLastSync = () => {
    if (!status.lastSync) return 'Never';
    return new Date(status.lastSync).toLocaleString();
};

    return (
        <Card className="p-4 w-full max-w-lg">
        <div className="space-y-4">
            <div className="flex justify-between items-center">
            <Text h3>Sync Status</Text>
            <Chip color={getStatusColor()} variant="flat">
                {status.state.toUpperCase()}
            </Chip>
            </div>

            {status.progress !== undefined && status.progress < 1 && (
            <Progress
                value={status.progress * 100}
                color={getStatusColor()}
                className="w-full"
            />
            )}

            <div className="space-y-2">
            <Text size="sm">Last Sync: {formatLastSync()}</Text>
            {status.error && (
                <Text color="danger" size="sm">
                Error: {status.error}
                </Text>
            )}
            </div>
        </div>
        </Card>
    );
};
