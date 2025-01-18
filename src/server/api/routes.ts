import { Router } from 'express';
import { MatrixClient } from '../matrix/client';
import { cryptoManager } from '../matrix/crypto';
import { SyncManager } from '../matrix/sync';
import { pgPool } from '../db/client';
import { z } from 'zod';
import { authenticateRequest } from '../middlware/auth';
import { KeyExportOptionsCustom } from '@/server/types';

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
    // syncManager = new SyncManager(matrixClient.getClient());
    // await syncManager.startSync();
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
  res.json(syncManager.getSyncStatus());
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
    const result = await pgPool.query(
      'SELECT * FROM rooms ORDER BY last_message_timestamp DESC'
    );
    res.json(result.rows);
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
    const result = await pgPool.query(
      `SELECT r.*,
        (SELECT json_agg(p.*) FROM participants p WHERE p.room_id = r.room_id) as participants
       FROM rooms r
       WHERE r.room_id = $1`,
      [roomId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    res.json(result.rows[0]);
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
      return;
    }

    const params = [roomId, Number(limit)];
    let query = `
      SELECT * FROM messages
      WHERE room_id = $1
      ${before ? 'AND timestamp < $3' : ''}
      ORDER BY timestamp DESC
      LIMIT $2
    `;

    if (before) {
      params.push(before as string);
    }

    const result = await pgPool.query(query, params);
    res.json(result.rows);
  } catch (error: any) {
    handleError(res, error);
  }
});

router.get('/users', authenticateRequest, async (_req, res) => {
  try {
    const result = await pgPool.query(
      'SELECT * FROM users ORDER BY display_name'
    );
    res.json(result.rows);
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
    const result = await pgPool.query(
      `SELECT u.*,
        (SELECT json_agg(r.*) FROM rooms r
         INNER JOIN participants p ON p.room_id = r.room_id
         WHERE p.user_id = u.user_id) as rooms
       FROM users u
       WHERE u.user_id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error: any) {
    handleError(res, error);
  }
});

// Crypto Routes

const keyFormatSchema = z.enum(['pkcs8', 'spki', 'pkcs1', 'sec1'] as const);
const formatOptions = z.union([z.literal('json'), z.literal('file')]);

export const exportKeysSchema = z
  .object({
    roomKeys: z.boolean().optional(),
    megolmKeys: z.boolean().optional(),
    olmKeys: z.boolean().optional(),
    format: z.union([keyFormatSchema, formatOptions]),
    password: z.string().optional(),
    iterations: z.number().positive().optional(),
    type: keyFormatSchema,
  })
  .strict();

router.post('/crypto/export', authenticateRequest, async (req, res) => {
  try {
    const keyExportOpts: KeyExportOptionsCustom = exportKeysSchema.parse(req.body);
    const keys = await cryptoManager.exportKeys(keyExportOpts);
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
    await cryptoManager.importKeys(req.body.keys);
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

router.post('/crypto/backup', authenticateRequest, async (req, res) => {
  try {
    const { passphrase } = req.params;
    await cryptoManager.createBackup(passphrase ?? '');
    res.json({ success: true });
  } catch (error: any) {
    handleError(res, error);
  }
});

router.post('/crypto/restore', authenticateRequest, async (req, res) => {
  try {
    const { passphrase } = req.params;
    await cryptoManager.recoverKeys(passphrase ?? '');
    res.json({ success: true });
  } catch (error: any) {
    handleError(res, error);
  }
});

// Stats Routes
router.get('/stats', authenticateRequest, async (_req, res) => {
  try {
    const stats = await pgPool.query(`
      SELECT
        (SELECT COUNT(*) FROM rooms) as total_rooms,
        (SELECT COUNT(*) FROM messages) as total_messages,
        (SELECT last_sync
         FROM sync_status
         ORDER BY created_at DESC
         LIMIT 1) as last_sync
    `);

    res.json({
      totalRooms: parseInt(stats.rows[0].total_rooms),
      totalMessages: parseInt(stats.rows[0].total_messages),
      lastSync: stats.rows[0].last_sync
    });
  } catch (error: any) {
    handleError(res, error);
  }
});

router.get('/logs', authenticateRequest, async (req, res) => {
  try {
    const { limit = 100 } = req.query;
    const result = await pgPool.query(
      'SELECT * FROM logs ORDER BY timestamp DESC LIMIT $1',
      [Number(limit)]
    );
    res.json(result.rows);
  } catch (error: any) {
    handleError(res, error);
  }
});

// Config Routes
router.get('/config', authenticateRequest, async (_req, res) => {
  try {
    const result = await pgPool.query('SELECT * FROM config LIMIT 1');
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Config not found' });
      return;
    }
    res.json(result.rows[0]);
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
    const result = await pgPool.query(
      'INSERT INTO config ($1) VALUES ($2) ON CONFLICT DO UPDATE SET $1 = $2 RETURNING *',
      [Object.keys(req.body), Object.values(req.body)]
    );
    res.json(result.rows[0]);
  } catch (error: any) {
    handleError(res, error);
  }
});

export default router;
