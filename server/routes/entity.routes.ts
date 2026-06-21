import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';
import { getContainer } from '../cosmos';
import { deleteBlob } from '../storage';
import { Entity } from '../../shared/models/entity.model';
import { Chapter } from '../../shared/models/chapter.model';
import { Book } from '../../shared/models/book.model';
import { TimelineEvent } from '../../shared/models/timeline-event.model';
import { withOwnerFilter, readOwnedItem } from '../owner-guard';
import { searchChapterChunks } from '../chapter-chunks';

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

interface MentionCountsDoc {
  id: string;
  owner?: string;
  chapterCount: number;
  chapterMaxTs: number;
  counts: Record<string, number>;
  computedAt: string;
}

// GET entity mention counts for a series (number of times each entity is
// referenced across chapter content). Results are cached in the mention-counts
// container; the cache is revalidated against the chapters' COUNT and MAX(_ts)
// so the expensive content scan only reruns when a chapter actually changes.
router.get('/series/:seriesId/mention-counts', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    const owner = req.user!.email;

    const booksContainer = getContainer('books');
    const { resources: books } = await booksContainer.items
      .query<{ id: string }>({
        query: 'SELECT c.id FROM c WHERE c.seriesId = @seriesId AND c.owner = @owner AND (NOT IS_DEFINED(c.archived) OR c.archived = false) AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)',
        parameters: [
          { name: '@seriesId', value: seriesId },
          { name: '@owner', value: owner },
        ],
      })
      .fetchAll();

    if (books.length === 0) {
      res.json({ counts: {} });
      return;
    }

    const bookIdParams = books.map((b, i) => ({ name: `@bookId${i}`, value: b.id }));
    const chapterFilter = `c.bookId IN (${bookIdParams.map(p => p.name).join(', ')}) AND c.owner = @owner AND (NOT IS_DEFINED(c.archived) OR c.archived = false)`;
    const chapterParams = [...bookIdParams, { name: '@owner', value: owner }];
    const chaptersContainer = getContainer('chapters');

    // Cheap freshness probe: chapter count + latest modification timestamp.
    const [countResult, maxTsResult] = await Promise.all([
      chaptersContainer.items
        .query<number>({ query: `SELECT VALUE COUNT(1) FROM c WHERE ${chapterFilter}`, parameters: chapterParams })
        .fetchAll(),
      chaptersContainer.items
        .query<number | null>({ query: `SELECT VALUE MAX(c._ts) FROM c WHERE ${chapterFilter}`, parameters: chapterParams })
        .fetchAll(),
    ]);
    const chapterCount = countResult.resources[0] ?? 0;
    const chapterMaxTs = maxTsResult.resources[0] ?? 0;

    const cacheContainer = getContainer('mention-counts');
    const cached = await readOwnedItem<MentionCountsDoc>(cacheContainer, seriesId, seriesId, req);
    if (cached && cached.chapterCount === chapterCount && cached.chapterMaxTs === chapterMaxTs) {
      res.json({ counts: cached.counts });
      return;
    }

    // Cache miss or stale: scan chapter content for entity-reference ids.
    const [{ resources: chapters }, { resources: entityIds }] = await Promise.all([
      chaptersContainer.items
        .query<{ content?: string; _ts: number }>({
          query: `SELECT c.content, c._ts FROM c WHERE ${chapterFilter}`,
          parameters: chapterParams,
        })
        .fetchAll(),
      container.items
        .query<string>(withOwnerFilter(req, {
          query: 'SELECT VALUE c.id FROM c WHERE c.seriesId = @seriesId AND (NOT IS_DEFINED(c.archived) OR c.archived = false) AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)',
          parameters: [{ name: '@seriesId', value: seriesId }],
        }))
        .fetchAll(),
    ]);

    // Entity references are embedded as <span data-id="{entityId}"> in the
    // chapter HTML; ids are UUIDs, so raw occurrence counting is unambiguous.
    const counts: Record<string, number> = {};
    for (const id of entityIds) counts[id] = 0;
    for (const chapter of chapters) {
      const content = chapter.content;
      if (!content) continue;
      for (const id of entityIds) {
        counts[id] += content.split(id).length - 1;
      }
    }

    const cacheDoc: MentionCountsDoc = {
      id: seriesId,
      owner,
      chapterCount: chapters.length,
      chapterMaxTs: chapters.reduce((max, c) => Math.max(max, c._ts ?? 0), 0),
      counts,
      computedAt: new Date().toISOString(),
    };
    await cacheContainer.items.upsert(cacheDoc);

    res.json({ counts });
  } catch (err) {
    console.error('Error fetching mention counts:', err);
    res.status(500).json({ error: 'Failed to fetch mention counts' });
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

// GET chapters where this entity appears (via entity-reference spans in chapter content)
router.get('/:id/chapters', async (req: Request, res: Response) => {
  const entityId = req.params['id'] as string;
  try {
    const entity = await readOwnedItem<Entity>(container, entityId, entityId, req);
    if (!entity?.seriesId) {
      res.json([]);
      return;
    }

    // Find all non-archived books in this series
    const booksContainer = getContainer('books');
    const { resources: books } = await booksContainer.items
      .query<Book>({
        query: 'SELECT c.id, c.title FROM c WHERE c.seriesId = @seriesId AND c.owner = @owner AND (NOT IS_DEFINED(c.archived) OR c.archived = false) AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)',
        parameters: [
          { name: '@seriesId', value: entity.seriesId },
          { name: '@owner', value: req.user!.email },
        ],
      })
      .fetchAll();

    if (books.length === 0) {
      res.json([]);
      return;
    }

    const bookMap = new Map(books.map(b => [b.id, b.title]));

    // Query chapters whose content contains this entity's id (as a data-id attribute value)
    const bookIdParams = books.map((b, i) => ({ name: `@bookId${i}`, value: b.id }));
    const bookIdList = bookIdParams.map(p => p.name).join(', ');
    const chaptersContainer = getContainer('chapters');
    const { resources: chapters } = await chaptersContainer.items
      .query<Chapter>({
        query: `SELECT c.id, c.title, c.bookId, c.sortOrder, c.imageUrl, c.imageThumbnailUrl FROM c WHERE c.bookId IN (${bookIdList}) AND c.owner = @owner AND (NOT IS_DEFINED(c.archived) OR c.archived = false) AND CONTAINS(c.content, @entityId)`,
        parameters: [
          ...bookIdParams,
          { name: '@owner', value: req.user!.email },
          { name: '@entityId', value: entityId },
        ],
      })
      .fetchAll();

    const result = chapters
      .map(c => ({
        id: c.id,
        title: c.title,
        sortOrder: c.sortOrder,
        bookId: c.bookId,
        bookTitle: bookMap.get(c.bookId) ?? 'Unknown Book',
        imageUrl: c.imageUrl,
        imageThumbnailUrl: c.imageThumbnailUrl,
      }))
      .sort((a, b) => {
        const bookCmp = a.bookTitle.localeCompare(b.bookTitle);
        return bookCmp !== 0 ? bookCmp : (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity);
      });

    res.json(result);
  } catch (err) {
    console.error('Error fetching entity chapters:', err);
    res.status(500).json({ error: 'Failed to fetch entity chapters' });
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
    const { url, thumbnailUrl, caption, hidden } = req.body as { url?: string; thumbnailUrl?: string; caption?: string; hidden?: boolean };
    if (!url || !thumbnailUrl) {
      res.status(400).json({ error: 'url and thumbnailUrl are required' });
      return;
    }
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const newPhoto = { url, thumbnailUrl, ...(caption ? { caption } : {}), ...(hidden ? { hidden: true } : {}) };
    const photos = [...(existing.photos ?? []), newPhoto];
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

// PATCH reorder photos
router.patch('/:id/photos/reorder', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { order } = req.body as { order: number[] };
    if (!Array.isArray(order)) {
      res.status(400).json({ error: 'order (array) is required' });
      return;
    }
    const existing = await readOwnedItem<Entity>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    const allPhotos = existing.photos ?? [];
    const coveredSet = new Set(order);
    const reordered = order.map(i => allPhotos[i]).filter(Boolean);
    const leftover = allPhotos.filter((_, i) => !coveredSet.has(i));
    const photos = [...reordered, ...leftover];
    const updated: Entity = { ...existing, photos, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Entity>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error reordering photos:', err);
    res.status(500).json({ error: 'Failed to reorder photos' });
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

// POST generate a biography from timeline events and chapter appearances
router.post('/:id/generate-biography', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;

    const entity = await readOwnedItem<Entity>(container, id, id, req);
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    // Fetch timeline events for this entity
    const eventsContainer = getContainer('timeline-events');
    const { resources: rawEvents } = await eventsContainer.items
      .query(
        withOwnerFilter(req, {
          query: 'SELECT * FROM c WHERE c.entityId = @entityId',
          parameters: [{ name: '@entityId', value: id }],
        }),
        { partitionKey: id },
      )
      .fetchAll();
    const events = (rawEvents as TimelineEvent[]).sort(
      (a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity),
    );

    // Vector search for the most relevant chapter passages referencing this entity
    const chunks = await searchChapterChunks(
      entity.name,
      { seriesId: entity.seriesId, topK: 10 },
      req,
    );

    // Fetch summaries for the chapters that surfaced in vector search
    let chapterSummaries: { title: string; summary: string }[] = [];
    if (chunks.length > 0) {
      const chapterIds = [...new Set(chunks.map(c => c.chapterId))];
      const chaptersContainer = getContainer('chapters');
      const placeholders = chapterIds.map((_, i) => `@cid${i}`).join(', ');
      const parameters = chapterIds.map((cid, i) => ({ name: `@cid${i}`, value: cid }));
      const { resources: chapters } = await chaptersContainer.items
        .query<Chapter>(
          withOwnerFilter(req, {
            query: `SELECT c.id, c.title, c.summary FROM c WHERE c.id IN (${placeholders})`,
            parameters,
          }),
        )
        .fetchAll();
      chapterSummaries = chapters
        .filter(c => c.summary)
        .map(c => ({ title: c.title, summary: c.summary! }));
    }

    // Build prompt
    const lines: string[] = [];
    lines.push(`Character name: ${entity.name}`);
    if (entity.personality) lines.push(`\nPersonality profile:\n${entity.personality}`);
    if (entity.biography) lines.push(`\nExisting biography (use as a starting point and expand):\n${entity.biography}`);

    if (events.length > 0) {
      lines.push('\nTimeline events (in story order):');
      for (const ev of events) {
        const parts = [ev.name];
        if (ev.timeframe) parts.push(`(${ev.timeframe})`);
        if (ev.location) parts.push(`at ${ev.location}`);
        if (ev.description) parts.push(`— ${ev.description}`);
        lines.push(`• ${parts.join(' ')}`);
      }
    }

    if (chapterSummaries.length > 0) {
      lines.push('\nChapter appearances:');
      for (const ch of chapterSummaries) {
        lines.push(`• "${ch.title}": ${ch.summary}`);
      }
    }

    if (chunks.length > 0) {
      lines.push('\nRelevant story passages:');
      for (const chunk of chunks.slice(0, 5)) {
        const stripped = chunk.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (stripped) lines.push(`"${stripped.slice(0, 300)}${stripped.length > 300 ? '…' : ''}"`);
      }
    }

    const contextBlock = lines.join('\n');
    const prompt =
      `You are an expert creative writing consultant. Using the character information below, ` +
      `write a compelling short biography for this character in 2–4 paragraphs. ` +
      `Write in third person. Focus on their background, key life events, motivations, and role in the story. ` +
      `Return only the biography text — no preamble, no headings.\n\n` +
      contextBlock;

    const completion = await aiClient.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [{ role: 'user', content: prompt }],
    });

    const biography = completion.choices[0]?.message?.content?.trim() ?? '';
    res.json({ biography });
  } catch (err) {
    console.error('Error generating biography:', err);
    res.status(500).json({ error: 'Failed to generate biography' });
  }
});

export default router;
