import { Router, Request, Response } from 'express';
import { getContainer } from '../cosmos';
import { listBlobs, deleteBlob } from '../storage';
import { Entity } from '../../shared/models/entity.model';

const router = Router();

/**
 * POST /api/backfill/series
 *
 * Ties all existing chat-sessions, chat-folders, and chat-folder-files that
 * have no seriesId to the first (and only) series owned by the requesting user.
 * Safe to call multiple times — already-tagged records are skipped.
 */
router.post('/series', async (req: Request, res: Response) => {
  const owner = req.user!.email;
  try {
    // Find the user's series
    const seriesContainer = getContainer('series');
    const { resources: allSeries } = await seriesContainer.items
      .query({
        query: `SELECT c.id FROM c WHERE c.owner = @owner
                  AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)
                  AND (NOT IS_DEFINED(c.archived) OR c.archived = false)`,
        parameters: [{ name: '@owner', value: owner }],
      })
      .fetchAll();

    if (allSeries.length === 0) {
      res.status(404).json({ error: 'No series found for this user' });
      return;
    }
    if (allSeries.length > 1) {
      res.status(400).json({
        error: 'Multiple series found — specify the target seriesId explicitly',
        seriesIds: allSeries.map((s: any) => s.id),
      });
      return;
    }

    const seriesId = allSeries[0].id;
    const counts = { sessions: 0, folders: 0, files: 0 };

    // Backfill chat-sessions
    const sessionsContainer = getContainer('chat-sessions');
    const { resources: sessions } = await sessionsContainer.items
      .query({
        query: `SELECT * FROM c WHERE c.owner = @owner
                  AND (NOT IS_DEFINED(c.seriesId) OR c.seriesId = null)`,
        parameters: [{ name: '@owner', value: owner }],
      })
      .fetchAll();
    for (const s of sessions) {
      await sessionsContainer.items.upsert({ ...s, seriesId });
      counts.sessions++;
    }

    // Backfill chat-folders
    const foldersContainer = getContainer('chat-folders');
    const { resources: folders } = await foldersContainer.items
      .query({
        query: `SELECT * FROM c WHERE c.owner = @owner
                  AND (NOT IS_DEFINED(c.seriesId) OR c.seriesId = null)`,
        parameters: [{ name: '@owner', value: owner }],
      })
      .fetchAll();
    for (const f of folders) {
      await foldersContainer.items.upsert({ ...f, seriesId });
      counts.folders++;
    }

    // Backfill chat-folder-files
    const filesContainer = getContainer('chat-folder-files');
    const { resources: files } = await filesContainer.items
      .query({
        query: `SELECT * FROM c WHERE c.owner = @owner
                  AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)
                  AND (NOT IS_DEFINED(c.seriesId) OR c.seriesId = null)`,
        parameters: [{ name: '@owner', value: owner }],
      })
      .fetchAll();
    for (const file of files) {
      await filesContainer.items.upsert({ ...file, seriesId });
      counts.files++;
    }

    res.json({ ok: true, seriesId, updated: counts });
  } catch (err) {
    console.error('Backfill error:', err);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

/**
 * POST /api/backfill/cleanup-entity-photos
 *
 * Deletes any blobs in Azure storage that were once entity photos but are no
 * longer referenced by any entity document in Cosmos DB.
 *
 * Only targets UUID-named image blobs (no "folder-files/" prefix). Blobs used
 * for folder file attachments are left untouched.
 *
 * Returns { deleted: string[], kept: number } so the caller can audit what was removed.
 */
router.post('/cleanup-entity-photos', async (req: Request, res: Response) => {
  try {
    // Build the set of all blob names currently referenced by any entity
    const entityContainer = getContainer('entities');
    const { resources: entities } = await entityContainer.items
      .query<Entity>('SELECT * FROM c WHERE NOT IS_DEFINED(c.deleted) OR c.deleted = false')
      .fetchAll();

    const referencedBlobNames = new Set<string>();
    const blobNameFromUrl = (url: string) => {
      try { return new URL(url).pathname.split('/').pop()!; } catch { return null; }
    };

    for (const entity of entities) {
      for (const urlField of [entity.thumbnailUrl, entity.originalUrl]) {
        if (urlField) {
          const name = blobNameFromUrl(urlField);
          if (name) referencedBlobNames.add(name);
        }
      }
      for (const photo of entity.photos ?? []) {
        const orig = blobNameFromUrl(photo.url);
        const thumb = blobNameFromUrl(photo.thumbnailUrl);
        if (orig) referencedBlobNames.add(orig);
        if (thumb) referencedBlobNames.add(thumb);
      }
    }

    // List all blobs and delete any entity-image blobs that are no longer referenced
    const allBlobs = await listBlobs();
    const toDelete = allBlobs.filter(
      name => !name.startsWith('folder-files/') && !referencedBlobNames.has(name)
    );

    await Promise.allSettled(toDelete.map(name => deleteBlob(name)));

    res.json({ deleted: toDelete, kept: allBlobs.length - toDelete.length });
  } catch (err) {
    console.error('Cleanup error:', err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

export default router;
