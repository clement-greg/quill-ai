import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import { SeriesMap } from '../../shared/models/map.model';
import { withOwnerFilter, readOwnedItem } from '../middleware/owner-guard';

const router = Router();
const container = getContainer('maps');

// GET maps by series (excludes archived)
router.get('/series/:seriesId', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const { resources } = await container.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    res.json(resources as SeriesMap[]);
  } catch (err) {
    console.error('Error fetching maps by series:', err);
    res.status(500).json({ error: 'Failed to fetch maps' });
  }
});

// GET single map by id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const resource = await readOwnedItem<SeriesMap>(container, id, id, req);
    if (!resource) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    res.json(resource);
  } catch (err) {
    console.error('Error fetching map:', err);
    res.status(500).json({ error: 'Failed to fetch map' });
  }
});

// POST create new map
router.post('/', async (req: Request, res: Response) => {
  try {
    const map: SeriesMap = req.body;
    if (!map.title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    if (!map.seriesId) {
      res.status(400).json({ error: 'Series is required' });
      return;
    }
    const now = new Date().toISOString();
    map.elements = map.elements ?? [];
    map.owner = map.owner || req.user!.email;
    map.createdBy = req.user!.email;
    map.createdAt = now;
    map.modifiedBy = req.user!.email;
    map.modifiedAt = now;
    const { resource } = await container.items.create<SeriesMap>(map);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating map:', err);
    res.status(500).json({ error: 'Failed to create map' });
  }
});

// PUT update map (title, background, elements, …)
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<SeriesMap>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    const updates: SeriesMap = {
      ...req.body,
      id,
      seriesId: existing.seriesId,
      owner: existing.owner,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    };
    const { resource } = await container.item(id, id).replace<SeriesMap>(updates);
    res.json(resource);
  } catch (err) {
    console.error('Error updating map:', err);
    res.status(500).json({ error: 'Failed to update map' });
  }
});

// PATCH archive map
router.patch('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<SeriesMap>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    const updated: SeriesMap = { ...existing, archived: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<SeriesMap>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error archiving map:', err);
    res.status(500).json({ error: 'Failed to archive map' });
  }
});

// DELETE map
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<SeriesMap>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    await container.item(id, id).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting map:', err);
    res.status(500).json({ error: 'Failed to delete map' });
  }
});

export default router;
