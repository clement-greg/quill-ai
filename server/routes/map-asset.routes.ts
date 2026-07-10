import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import { deleteBlob } from '../services/storage';
import { MapAsset } from '../../shared/models/map-asset.model';
import { withOwnerFilter, readOwnedItem } from '../middleware/owner-guard';

const router = Router();
const container = getContainer('map-assets');

// GET asset palette for a series
router.get('/series/:seriesId', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const { resources } = await container.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    res.json(resources as MapAsset[]);
  } catch (err) {
    console.error('Error fetching map assets:', err);
    res.status(500).json({ error: 'Failed to fetch map assets' });
  }
});

// POST create asset (image is already uploaded via /api/upload)
router.post('/', async (req: Request, res: Response) => {
  try {
    const asset: MapAsset = req.body;
    if (!asset.seriesId || !asset.imageUrl || !asset.thumbnailUrl) {
      res.status(400).json({ error: 'seriesId, imageUrl and thumbnailUrl are required' });
      return;
    }
    const now = new Date().toISOString();
    asset.name = asset.name || 'Stamp';
    asset.owner = asset.owner || req.user!.email;
    asset.createdBy = req.user!.email;
    asset.createdAt = now;
    asset.modifiedBy = req.user!.email;
    asset.modifiedAt = now;
    const { resource } = await container.items.create<MapAsset>(asset);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating map asset:', err);
    res.status(500).json({ error: 'Failed to create map asset' });
  }
});

// PATCH update an asset's name and/or category.
//   { name?: string, category?: string | null } — an empty/null category clears it.
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<MapAsset>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }
    const { name, category } = req.body as { name?: string; category?: string | null };
    if (typeof name === 'string' && name.trim()) existing.name = name.trim();
    if (category !== undefined) {
      const trimmed = (category ?? '').trim();
      if (trimmed) existing.category = trimmed;
      else delete existing.category;
    }
    existing.modifiedBy = req.user!.email;
    existing.modifiedAt = new Date().toISOString();
    const { resource } = await container.item(id, id).replace(existing);
    res.json(resource);
  } catch (err) {
    console.error('Error updating map asset:', err);
    res.status(500).json({ error: 'Failed to update map asset' });
  }
});

// DELETE asset (also removes its blobs)
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<MapAsset>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }
    await container.item(id, id).delete();
    const blobNameFromUrl = (url: string) => new URL(url).pathname.split('/').pop()!;
    await Promise.allSettled([
      deleteBlob(blobNameFromUrl(existing.imageUrl)),
      deleteBlob(blobNameFromUrl(existing.thumbnailUrl)),
    ]);
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting map asset:', err);
    res.status(500).json({ error: 'Failed to delete map asset' });
  }
});

export default router;
