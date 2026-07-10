import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getContainer } from '../services/cosmos';

const router = Router();

// GET / — list all folders for the authenticated user
router.get('/', async (req: Request, res: Response) => {
  try {
    const container = getContainer('chat-folders');
    const seriesId = req.query['seriesId'] as string | undefined;
    const params: any[] = [{ name: '@owner', value: req.user!.email }];
    let seriesFilter = '';
    if (seriesId) {
      seriesFilter = ' AND (c.seriesId = @seriesId OR IS_NULL(c.seriesId) OR NOT IS_DEFINED(c.seriesId))';
      params.push({ name: '@seriesId', value: seriesId });
    }
    const { resources } = await container.items
      .query({
        query: `SELECT * FROM c WHERE c.owner = @owner${seriesFilter} ORDER BY c.name ASC`,
        parameters: params,
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error('Error listing chat folders:', err);
    res.status(500).json({ error: 'Failed to list folders' });
  }
});

// POST / — create a new folder
router.post('/', async (req: Request, res: Response) => {
  const { name, parentFolderId = null, seriesId = null } = req.body;
  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const now = new Date().toISOString();
  const folder = {
    id: randomUUID(),
    owner: req.user!.email,
    name: String(name).trim(),
    parentFolderId: parentFolderId ?? null,
    seriesId: seriesId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const container = getContainer('chat-folders');
    await container.items.create(folder);
    res.json(folder);
  } catch (err) {
    console.error('Error creating chat folder:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// PUT /:id — rename or re-parent a folder
router.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  try {
    const container = getContainer('chat-folders');
    const { resource } = await container.item(id, id).read<any>();
    if (!resource || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }
    const updated = {
      ...resource,
      ...(req.body.name !== undefined && { name: String(req.body.name).trim() }),
      ...(req.body.parentFolderId !== undefined && { parentFolderId: req.body.parentFolderId }),
      updatedAt: new Date().toISOString(),
    };
    await container.items.upsert(updated);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating chat folder:', err);
    res.status(500).json({ error: 'Failed to update folder' });
  }
});

// DELETE /:id — delete folder; re-parent child folders and sessions to this folder's parent
router.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  try {
    const foldersContainer = getContainer('chat-folders');
    const { resource } = await foldersContainer.item(id, id).read<any>();
    if (!resource || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Folder not found' });
      return;
    }
    const parentFolderId = resource.parentFolderId ?? null;

    // Re-parent direct child folders to this folder's parent
    const { resources: childFolders } = await foldersContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.owner = @owner AND c.parentFolderId = @id',
        parameters: [
          { name: '@owner', value: req.user!.email },
          { name: '@id', value: id },
        ],
      })
      .fetchAll();
    for (const cf of childFolders) {
      await foldersContainer.items.upsert({ ...cf, parentFolderId });
    }

    // Re-parent sessions in this folder to this folder's parent
    const sessionsContainer = getContainer('chat-sessions');
    const { resources: sessions } = await sessionsContainer.items
      .query({
        query: `SELECT * FROM c WHERE c.owner = @owner AND c.folderId = @id
                  AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)`,
        parameters: [
          { name: '@owner', value: req.user!.email },
          { name: '@id', value: id },
        ],
      })
      .fetchAll();
    for (const s of sessions) {
      await sessionsContainer.items.upsert({ ...s, folderId: parentFolderId });
    }

    // Delete the folder itself
    await foldersContainer.item(id, id).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting chat folder:', err);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

export default router;
