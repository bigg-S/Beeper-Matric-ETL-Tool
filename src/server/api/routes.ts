import { Router } from 'express';
import { MatrixClient } from '../matrix/client';
import { cryptoManager } from '../matrix/crypto';
import { SyncManager } from '../matrix/sync';
import { supabase } from '../db/client';

const router = Router();
let matrixClient: MatrixClient | null = null;
let syncManager: SyncManager | null = null;

router.post('/auth/login', async (req, res) => {
    try {
        const { username, password, domain } = req.body;
        matrixClient = new MatrixClient({ username, password, domain });
        await matrixClient.initialize();
        syncManager = new SyncManager(matrixClient.getClient());
        await syncManager.startSync();
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/sync/status', async (req, res) => {
    if (!syncManager) {
        return res.status(400).json({ error: 'Sync not initialized' });
    }
    res.json(syncManager.getSyncState());
});

router.get('/stats', async (req, res) => {
    try {
        const [roomCount, messageCount, lastSync] = await Promise.all([
        supabase.from('rooms').select('count'),
        supabase.from('messages').select('count'),
        supabase.from('sync_status').select('last_sync').order('created_at', { ascending: false }).limit(1),
        ]);

        res.json({
        totalRooms: roomCount.data?.[0]?.count || 0,
        totalMessages: messageCount.data?.[0]?.count || 0,
        lastSync: lastSync.data?.[0]?.last_sync,
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/crypto/export', async (req, res) => {
    try {
        const keys = await cryptoManager.exportE2EKeys();
        res.json({ keys });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/crypto/import', async (req, res) => {
    try {
        await cryptoManager.importE2EKeys(req.body.keys);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
