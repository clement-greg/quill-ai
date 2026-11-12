/**
 * Database backups: status and a manual trigger. There is deliberately no
 * download route — any Google account can sign in, and a backup holds every
 * user's data. The zips are fetched from the storage account (backups/ folder).
 */
import { Router, Request, Response } from 'express';
import { getBackupStatus, startBackup } from '../services/database-backup';

const router = Router();

// GET /api/backups — last run, next scheduled run, and the backups on hand
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json(await getBackupStatus());
  } catch (err) {
    console.error('[backups] GET status error:', err);
    res.status(500).json({ error: 'Failed to load backup status' });
  }
});

// POST /api/backups/run — start a backup now; 202 once started, 409 if one is already running
router.post('/run', async (req: Request, res: Response): Promise<void> => {
  try {
    const run = await startBackup('manual', req.user?.email);
    if (!run) {
      res.status(409).json({ error: 'A backup is already running' });
      return;
    }
    res.status(202).json(run);
  } catch (err) {
    console.error('[backups] POST run error:', err);
    res.status(500).json({ error: 'Failed to start backup' });
  }
});

export default router;
