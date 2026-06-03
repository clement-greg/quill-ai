import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';
import { getContainer } from '../cosmos';
import { deleteBlob } from '../storage';
import { Entity } from '../../shared/models/entity.model';
import { withOwnerFilter, readOwnedItem } from '../owner-guard';

const aiClient = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

const router = Router();
const container = getContainer('entities');

// GET all entities
router.get('/', async (req: Request, res: Response) => {
  try {
    const { resources } = await container.items
      .query(withOwnerFilter(req, 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.archived) OR c.archived = false)'))
      .fetchAll();
    res.json(resources as Entity[]);
  } catch (err) {
    console.error('Error fetching entities:', err);
    res.status(500).json({ error: 'Failed to fetch entities' });
  }
});

// GET entities by series
router.get('/series/:seriesId', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const { resources } = await container.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    res.json(resources as Entity[]);
  } catch (err) {
    console.error('Error fetching entities by series:', err);
    res.status(500).json({ error: 'Failed to fetch entities by series' });
  }
});

// GET archived entities by series
router.get('/series/:seriesId/archived', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const { resources } = await container.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND c.archived = true AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    res.json(resources as Entity[]);
  } catch (err) {
    console.error('Error fetching archived entities by series:', err);
    res.status(500).json({ error: 'Failed to fetch archived entities' });
  }
});

// GET all archived entities (cross-series)
router.get('/archived', async (req: Request, res: Response) => {
  try {
    const { resources } = await container.items
      .query(withOwnerFilter(req, 'SELECT * FROM c WHERE c.archived = true AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)'))
      .fetchAll();
    res.json(resources as Entity[]);
  } catch (err) {
    console.error('Error fetching archived entities:', err);
    res.status(500).json({ error: 'Failed to fetch archived entities' });
  }
});

// GET narrator entity for a series – creates one if it does not yet exist
router.get('/narrator/:seriesId', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const { resources } = await container.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND c.isNarrator = true',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();

    if (resources.length > 0) {
      res.json(resources[0] as Entity);
      return;
    }

    // Create the narrator for this series
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const narrator: Entity = {
      id: randomUUID(),
      name: 'Narrator',
      type: 'PERSON',
      seriesId,
      isNarrator: true,
      owner: req.user!.email,
      createdBy: req.user!.email,
      createdAt: now,
      modifiedBy: req.user!.email,
      modifiedAt: now,
    };
    const { resource } = await container.items.create<Entity>(narrator);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error fetching/creating narrator:', err);
    res.status(500).json({ error: 'Failed to fetch narrator' });
  }
});

// GET single entity by id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const resource = await readOwnedItem<Entity>(container, id, id, req);
    if (!resource) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    res.json(resource);
  } catch (err) {
    console.error('Error fetching entity:', err);
    res.status(500).json({ error: 'Failed to fetch entity' });
  }
});

// POST create new entity
router.post('/', async (req: Request, res: Response) => {
  try {
    const entity: Entity = req.body;
    if (!entity.name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }
    if (!entity.seriesId) {
      res.status(400).json({ error: 'Series is required' });
      return;
    }
    if (!entity.type || !['PERSON', 'PLACE', 'THING'].includes(entity.type)) {
      res.status(400).json({ error: 'Type must be PERSON, PLACE, or THING' });
      return;
    }
    const now = new Date().toISOString();
    entity.owner = entity.owner || req.user!.email;
    entity.createdBy = req.user!.email;
    entity.createdAt = now;
    entity.modifiedBy = req.user!.email;
    entity.modifiedAt = now;
    const { resource } = await container.items.create<Entity>(entity);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating entity:', err);
    res.status(500).json({ error: 'Failed to create entity' });
  }
});

// PUT update entity
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const updates: Entity = {
      ...req.body,
      id,
      owner: existing.owner,
      // Photos are managed exclusively through POST/DELETE /photos endpoints;
      // always preserve them so a stale client draft cannot clobber them.
      photos: existing.photos,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    };
    // Narrator name is immutable
    if (existing.isNarrator) {
      updates.name = 'Narrator';
      updates.isNarrator = true;
    }
    const { resource } = await container.item(id, id).replace<Entity>(updates);
    res.json(resource);
  } catch (err) {
    console.error('Error updating entity:', err);
    res.status(500).json({ error: 'Failed to update entity' });
  }
});

// PATCH reorder entities (bulk sort-order update)
router.patch('/reorder', async (req: Request, res: Response) => {
  try {
    const { ids }: { ids: string[] } = req.body;
    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array' });
      return;
    }
    const now = new Date().toISOString();
    await Promise.all(
      ids.map(async (id, index) => {
        const existing = await readOwnedItem<Entity>(container, id, id, req);
        if (existing) {
          const updated: Entity = { ...existing, sortOrder: index, modifiedBy: req.user!.email, modifiedAt: now };
          await container.item(id, id).replace<Entity>(updated);
        }
      }),
    );
    res.status(204).send();
  } catch (err) {
    console.error('Error reordering entities:', err);
    res.status(500).json({ error: 'Failed to reorder entities' });
  }
});

// PATCH archive entity
router.patch('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    if (existing.isNarrator) {
      res.status(400).json({ error: 'The narrator cannot be archived' });
      return;
    }
    const updated: Entity = { ...existing, archived: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Entity>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error archiving entity:', err);
    res.status(500).json({ error: 'Failed to archive entity' });
  }
});

// PATCH unarchive entity
router.patch('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const updated: Entity = { ...existing, archived: false, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Entity>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error unarchiving entity:', err);
    res.status(500).json({ error: 'Failed to unarchive entity' });
  }
});

// PATCH soft-delete entity
router.patch('/:id/soft-delete', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    if (existing.isNarrator) {
      res.status(400).json({ error: 'The narrator cannot be deleted' });
      return;
    }
    const updated: Entity = { ...existing, deleted: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Entity>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error soft-deleting entity:', err);
    res.status(500).json({ error: 'Failed to soft-delete entity' });
  }
});

// PATCH restore soft-deleted entity
router.patch('/:id/restore-delete', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const updated: Entity = { ...existing, deleted: false, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Entity>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error restoring entity:', err);
    res.status(500).json({ error: 'Failed to restore entity' });
  }
});

// DELETE entity
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    await container.item(id, id).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting entity:', err);
    res.status(500).json({ error: 'Failed to delete entity' });
  }
});

// POST add a photo to a person entity
router.post('/:id/photos', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { url, thumbnailUrl, caption } = req.body as { url?: string; thumbnailUrl?: string; caption?: string };
    if (!url || !thumbnailUrl) {
      res.status(400).json({ error: 'url and thumbnailUrl are required' });
      return;
    }
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const photos = [...(existing.photos ?? []), { url, thumbnailUrl, ...(caption ? { caption } : {}) }];
    const updated: Entity = { ...existing, photos, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Entity>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error adding photo:', err);
    res.status(500).json({ error: 'Failed to add photo' });
  }
});

// DELETE remove a photo from a person entity by index
router.delete('/:id/photos/:index', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const index = parseInt(req.params['index'] as string, 10);
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const allPhotos = existing.photos ?? [];
    const photo = allPhotos[index];
    const photos = allPhotos.filter((_, i) => i !== index);
    const updated: Entity = { ...existing, photos, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Entity>(updated);
    if (photo) {
      const blobNameFromUrl = (url: string) => new URL(url).pathname.split('/').pop()!;
      await Promise.allSettled([
        deleteBlob(blobNameFromUrl(photo.url)),
        deleteBlob(blobNameFromUrl(photo.thumbnailUrl)),
      ]);
    }
    res.json(resource);
  } catch (err) {
    console.error('Error removing photo:', err);
    res.status(500).json({ error: 'Failed to remove photo' });
  }
});

// PATCH set hidden flag on one or more photos by index
router.patch('/:id/photos/visibility', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { indices, hidden } = req.body as { indices: number[]; hidden: boolean };
    if (!Array.isArray(indices) || typeof hidden !== 'boolean') {
      res.status(400).json({ error: 'indices (array) and hidden (boolean) are required' });
      return;
    }
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const photos = (existing.photos ?? []).map((p, i) =>
      indices.includes(i) ? { ...p, hidden } : p
    );
    const updated: Entity = { ...existing, photos, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Entity>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error updating photo visibility:', err);
    res.status(500).json({ error: 'Failed to update photo visibility' });
  }
});

// POST generate a personality prompt from basic entity info
router.post('/:id/generate-personality', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const basicDescription: string = req.body.basicDescription ?? '';

    const resource = await readOwnedItem<Entity>(container, id, id, req);
    if (!resource) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const name = resource.name ?? 'this character';
    const biography = resource.biography ?? '';

    const metaPrompt =
      `You are an expert creative writing consultant. A user is writing a story featuring a character named "${name}"` +
      (biography ? ` with the following biography: ${biography}` : '') + `.
` +
      `Based on the following basic description, write a thorough personality profile for this character. ` +
      `Cover their speech patterns, mannerisms, emotional tendencies, values, fears, how they respond under pressure, ` +
      `and any quirks that would help an AI write authentic dialog for them. ` +
      `Return only the personality profile text — no explanations, no preamble.\n\n` +
      `Basic description: ${basicDescription}`;

    const completion = await aiClient.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [{ role: 'user', content: metaPrompt }],
    });

    const personality = completion.choices[0]?.message?.content?.trim() ?? '';
    res.json({ personality });
  } catch (err) {
    console.error('Error generating personality:', err);
    res.status(500).json({ error: 'Failed to generate personality' });
  }
});

export default router;
