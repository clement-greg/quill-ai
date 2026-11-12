/**
 * Database backups — SA only, since a backup holds every user's data. Status,
 * manual trigger, download, delete, and an insert-only restore (with a preview).
 * Backups are addressed by file name alone (e.g. quill-backup-2026-11-12T15-44-20Z.zip);
 * anything that isn't a backup name is rejected before it reaches storage.
 */
import { Router, Request, Response } from 'express';
import {
  BACKUP_PREFIX,
  getBackupStatus,
  isBackupBlobName,
  startBackup,
} from '../services/database-backup';
import { isRestoreRunning, previewRestore, startRestore } from '../services/database-restore';
import { deleteBlob, downloadBlobStreamRaw, listBlobsWithPrefix } from '../services/storage';
import { requireSa } from '../services/sa-access';

const router = Router();
router.use(requireSa);

/** The blob name for a :file param, or null (after sending 400/404) if it isn't an existing backup. */
async function resolveBackup(req: Request, res: Response): Promise<string | null> {
  const blobName = `${BACKUP_PREFIX}${String(req.params['file'])}`;
  if (!isBackupBlobName(blobName)) {
    res.status(400).json({ error: 'Not a backup file name' });
    return null;
  }
  const exists = (await listBlobsWithPrefix(blobName)).some(b => b.name === blobName);
  if (!exists) {
    res.status(404).json({ error: 'Backup not found' });
    return null;
  }
  return blobName;
}

// GET /api/backups — last run, next scheduled run, the backups on hand, and any restore
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

// GET /api/backups/:file/download
router.get('/:file/download', async (req: Request, res: Response): Promise<void> => {
  try {
    const blobName = await resolveBackup(req, res);
    if (!blobName) return;
    const { stream, sizeBytes } = await downloadBlobStreamRaw(blobName);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${blobName.slice(BACKUP_PREFIX.length)}"`);
    if (sizeBytes !== undefined) res.setHeader('Content-Length', String(sizeBytes));
    stream.pipe(res);
  } catch (err) {
    console.error('[backups] download error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to download backup' });
  }
});

// DELETE /api/backups/:file
router.delete('/:file', async (req: Request, res: Response): Promise<void> => {
  try {
    const blobName = await resolveBackup(req, res);
    if (!blobName) return;
    if (isRestoreRunning()) {
      res.status(409).json({ error: 'A restore is running' });
      return;
    }
    await deleteBlob(blobName);
    console.log(`[backups] ${blobName} deleted by ${req.user?.email}`);
    res.status(204).end();
  } catch (err) {
    console.error('[backups] delete error:', err);
    res.status(500).json({ error: 'Failed to delete backup' });
  }
});

// POST /api/backups/:file/restore-preview — what a restore would add and skip; writes nothing
router.post('/:file/restore-preview', async (req: Request, res: Response): Promise<void> => {
  try {
    const blobName = await resolveBackup(req, res);
    if (!blobName) return;
    res.json(await previewRestore(blobName));
  } catch (err) {
    console.error('[backups] restore preview error:', err);
    res.status(500).json({ error: 'Failed to read backup' });
  }
});

// POST /api/backups/:file/restore — insert-only restore in the background; 409 if one is running
router.post('/:file/restore', async (req: Request, res: Response): Promise<void> => {
  try {
    const blobName = await resolveBackup(req, res);
    if (!blobName) return;
    const run = startRestore(blobName, req.user!.email);
    if (!run) {
      res.status(409).json({ error: 'A restore is already running' });
      return;
    }
    res.status(202).json(run);
  } catch (err) {
    console.error('[backups] restore error:', err);
    res.status(500).json({ error: 'Failed to start restore' });
  }
});

export default router;
