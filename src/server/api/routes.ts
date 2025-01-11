import { Router } from 'express';
import { MatrixClient } from '../matrix/client';
import { cryptoManager } from '../matrix/crypto';
import { SyncManager } from '../matrix/sync';
import { supabase } from '../db/client';
import { z } from 'zod';
import { authenticateRequest } from '../middlware/auth';

const router = Router();
let matrixClient: MatrixClient | null = null;
let syncManager: SyncManager | null = null;

const handleError = (res: any, error: any, status = 500) => {
    console.error(error);
    res.status(status).json({ error: error.message || 'An unknown error occurred' });
};


const loginSchema = z.object({
    username: z.string(),
    password: z.string(),
    domain: z.string().url(),
});

// Authentication Routes
router.post('/auth/login', async (req, res) => {
    try {
        const { username, password, domain } = loginSchema.parse(req.body);
        matrixClient = new MatrixClient({ username, password, domain });
        await matrixClient.initialize();
        syncManager = new SyncManager(matrixClient.getClient());
        await syncManager.startSync();
        res.json({ success: true });
    } catch (error: any) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/auth/logout', authenticateRequest, async (_req, res) => {
    try {
        if (syncManager) await syncManager.stopSync();
        if (matrixClient) await matrixClient.logout();
        matrixClient = null;
        syncManager = null;
        res.json({ success: true });
    } catch (error: any) {
        handleError(res, error);
    }
});

router.get('/auth/me', authenticateRequest, async (_req, res) => {
    try {
        if (!matrixClient) throw new Error('Matrix client is not initialized.');

        const userId = matrixClient.getClient().getUserId();
        if (!userId) throw new Error('User ID not found.');

        const userData = await matrixClient.getUserProfile(userId);

        res.json(userData);
    } catch (error: any) {
        handleError(res, error);
    }
});


// Sync Routes
router.get('/sync/status', authenticateRequest, async (_req, res) => {
    if (!syncManager) {
        res.status(400).json({ error: 'Sync not initialized' });
        return;
    }
    res.json(syncManager.getSyncState());
});

router.post('/sync/start', authenticateRequest, async (_req, res) => {
    try {
        if (!syncManager) throw new Error('Sync manager not initialized');
        await syncManager.startSync();
        res.json({ success: true });
    } catch (error: any) {
        handleError(res, error);
    }
});

router.post('/sync/stop', authenticateRequest, async (_req, res) => {
    try {
        if (!syncManager) throw new Error('Sync manager not initialized');
        await syncManager.stopSync();
        res.json({ success: true });
    } catch (error: any) {
        handleError(res, error);
    }
});

// Data Routes
router.get('/rooms', authenticateRequest, async (_req, res) => {
    try {
        const { data, error } = await supabase
            .from('rooms')
            .select('*')
            .order('last_message_timestamp', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        handleError(res, error);
    }
});

router.get('/rooms/:roomId', authenticateRequest, async (req, res) => {
    try {
        const { roomId } = req.params;
        if (!roomId) {
            res.status(400).json({ error: 'Room ID is required' });
            return;
        }
        const { data, error } = await supabase
            .from('rooms')
            .select('*, participants(*)')
            .eq('room_id', roomId)
            .single();
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        handleError(res, error);
    }
});

router.get('/rooms/:roomId/messages', authenticateRequest, async (req, res) => {
    try {
        const { roomId } = req.params;
        const { limit = 50, before } = req.query;
        if (!roomId) {
            res.status(400).json({ error: 'Room ID is required' });
            return
        }

        let query = supabase
            .from('messages')
            .select('*')
            .eq('room_id', roomId)
            .order('timestamp', { ascending: false })
            .limit(Number(limit));

        if (before) {
            query = query.lt('timestamp', before);
        }

        const { data, error } = await query;
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        handleError(res, error);
    }
});

router.get('/users', authenticateRequest, async (_req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .order('display_name');
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        handleError(res, error);
    }
});

router.get('/users/:userId', authenticateRequest, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userId) {
            res.status(400).json({ error: 'User ID is required' });
            return;
        }
        const { data, error } = await supabase
            .from('users')
            .select('*, rooms(*)')
            .eq('user_id', userId)
            .single();
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        handleError(res, error);
    }
});

// Crypto Routes
router.post('/crypto/export', authenticateRequest, async (_req, res) => {
    try {
        const keys = await cryptoManager.exportE2EKeys();
        res.json({ keys });
    } catch (error: any) {
        handleError(res, error);
    }
});

router.post('/crypto/import', authenticateRequest, async (req, res) => {
    try {
        if (!req.body.keys) {
            res.status(400).json({ error: 'Keys are required' });
            return;
        }
        await cryptoManager.importE2EKeys(req.body.keys);
        res.json({ success: true });
    } catch (error: any) {
        handleError(res, error);
    }
});

router.get('/crypto/status', authenticateRequest, async (_req, res) => {
    try {
        const status = await cryptoManager.getStatus();
        res.json(status);
    } catch (error: any) {
        handleError(res, error);
    }
});

router.post('/crypto/backup', authenticateRequest, async (_req, res) => {
    try {
        await cryptoManager.backupKeys();
        res.json({ success: true });
    } catch (error: any) {
        handleError(res, error);
    }
});

router.post('/crypto/restore', authenticateRequest, async (_req, res) => {
    try {
        await cryptoManager.restoreKeys();
        res.json({ success: true });
    } catch (error: any) {
        handleError(res, error);
    }
});

// Stats Routes
router.get('/stats', authenticateRequest, async (_req, res) => {
    try {
        const [roomCount, messageCount, lastSync] = await Promise.all([
            supabase.from('rooms').select('count'),
            supabase.from('messages').select('count'),
            supabase
                .from('sync_status')
                .select('last_sync')
                .order('created_at', { ascending: false })
                .limit(1),
        ]);

        res.json({
            totalRooms: roomCount.data?.[0]?.count || 0,
            totalMessages: messageCount.data?.[0]?.count || 0,
            lastSync: lastSync.data?.[0]?.last_sync,
        });
    } catch (error: any) {
        handleError(res, error);
    }
});

router.get('/logs', authenticateRequest, async (req, res) => {
    try {
        const { limit = 100 } = req.query;
        const { data, error } = await supabase
            .from('logs')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(Number(limit));
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        handleError(res, error);
    }
});

// Config Routes
router.get('/config', authenticateRequest, async (_req, res) => {
    try {
        const { data, error } = await supabase.from('config').select('*').single();
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        handleError(res, error);
    }
});

router.post('/config', authenticateRequest, async (req, res) => {
    try {
        if (!req.body) {
            res.status(400).json({ error: 'Request body is required' });
            return;
        }
        const { data, error } = await supabase.from('config').upsert(req.body).single();
        if (error) throw error;
        res.json(data);
    } catch (error: any) {
        handleError(res, error);
    }
});

export default router;
