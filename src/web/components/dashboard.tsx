import { useState, useEffect } from 'react';
import { Card, Button, Text, Grid, Loading } from '@nextui-org/react';
import { SyncStatusComponent } from './sync-status';
import APIClient from '../lib/api';
import { Download, Upload, RefreshCw } from 'lucide-react';

export const Dashboard = () => {
const [stats, setStats] = useState<{
    totalRooms: number;
    totalMessages: number;
    lastSync: string;
} | null>(null);

const [loading, setLoading] = useState({
    stats: false,
    export: false,
    import: false,
    restart: false,
});

useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
}, []);

const fetchStats = async () => {
    try {
    setLoading(prev => ({ ...prev, stats: true }));
    const data = await APIClient.getStats();
    setStats(data);
    } catch (error) {
    console.error('Failed to fetch stats:', error);
    } finally {
    setLoading(prev => ({ ...prev, stats: false }));
    }
};

const handleExportKeys = async () => {
    try {
    setLoading(prev => ({ ...prev, export: true }));
    const { keys } = await APIClient.exportE2EKeys();
    const blob = new Blob([keys], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'matrix-e2e-keys.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    } catch (error) {
    console.error('Failed to export keys:', error);
    } finally {
    setLoading(prev => ({ ...prev, export: false }));
    }
};

const handleImportKeys = async () => {
    try {
    setLoading(prev => ({ ...prev, import: true }));
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
        const keys = await file.text();
        await APIClient.importE2EKeys(keys);
        }
    };
    input.click();
    } catch (error) {
    console.error('Failed to import keys:', error);
    } finally {
    setLoading(prev => ({ ...prev, import: false }));
    }
};

const handleRestartSync = async () => {
    try {
    setLoading(prev => ({ ...prev, restart: true }));
    await APIClient.restartSync();
    } catch (error) {
    console.error('Failed to restart sync:', error);
    } finally {
    setLoading(prev => ({ ...prev, restart: false }));
    }
};

return (
    <div className="space-y-6">
    <SyncStatusComponent />

    <Grid.Container gap={2}>
        <Grid xs={12} sm={6}>
        <Card className="w-full p-4">
            <Text h4>Statistics</Text>
            {loading.stats ? (
            <Loading />
            ) : stats ? (
            <div className="space-y-2">
                <Text>Total Rooms: {stats.totalRooms}</Text>
                <Text>Total Messages: {stats.totalMessages}</Text>
                <Text>Last Sync: {new Date(stats.lastSync).toLocaleString()}</Text>
            </div>
            ) : null}
        </Card>
        </Grid>

        <Grid xs={12} sm={6}>
        <Card className="w-full p-4">
            <Text h4>Actions</Text>
            <div className="space-y-2">
            <Button
                icon={<Download />}
                onClick={handleExportKeys}
                disabled={loading.export}
                className="w-full"
            >
                Export E2E Keys
            </Button>
            <Button
                icon={<Upload />}
                onClick={handleImportKeys}
                disabled={loading.import}
                className="w-full"
            >
                Import E2E Keys
            </Button>
            <Button
                icon={<RefreshCw />}
                onClick={handleRestartSync}
                disabled={loading.restart}
                className="w-full"
            >
                Restart Sync
            </Button>
            </div>
        </Card>
        </Grid>
    </Grid.Container>
    </div>
);
};
