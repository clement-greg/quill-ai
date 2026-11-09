import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getContainer } from '../services/cosmos';
import { generateEmbedding } from '../services/embeddings';
import {
  Thought,
  ThoughtPage,
  ThoughtTagCount,
  DEFAULT_THOUGHT_PAGE_SIZE,
  MAX_THOUGHT_PAGE_SIZE,
  normalizeThoughtTags,
} from '../../shared/models/thought.model';
import { readOwnedItem } from '../middleware/owner-guard';

const router = Router();
const container = getContainer('thought-items');

/** Builds the text to embed: title (if any) prepended to content. */
function embeddingText(thought: Pick<Thought, 'title' | 'content'>): string {
  return thought.title ? `${thought.title}\n\n${thought.content}` : thought.content;
}

/** Reads a non-negative integer query param, falling back when absent or junk. */
function intParam(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Counts each tag across the thoughts, merging case variants, sorted alphabetically. */
function tagCounts(thoughts: Thought[]): ThoughtTagCount[] {
  const byKey = new Map<string, ThoughtTagCount>();
  for (const t of thoughts) {
    for (const tag of t.tags ?? []) {
      const key = tag.toLowerCase();
      const entry = byKey.get(key);
      if (entry) entry.count++;
      else byKey.set(key, { tag, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }));
}

// GET a page of the current user's thoughts, newest first.
//   ?tags=a,b   only thoughts carrying every listed tag (case-insensitive)
//   ?offset=0   thoughts to skip
//   ?limit=50   page size (capped at MAX_THOUGHT_PAGE_SIZE)
router.get('/', async (req: Request, res: Response) => {
  try {
    const email = req.user!.email;
    const filter = normalizeThoughtTags(String(req.query['tags'] ?? '').split(',')).map((t) => t.toLowerCase());
    const offset = intParam(req.query['offset'], 0);
    const limit = Math.min(Math.max(intParam(req.query['limit'], DEFAULT_THOUGHT_PAGE_SIZE), 1), MAX_THOUGHT_PAGE_SIZE);

    // Project away contentVector: it is ~1536 floats per thought and the list never needs it.
    // Tag filtering happens here rather than in SQL so the response can also carry the
    // caller's full tag list; one partition's worth of light documents is cheap to scan.
    const { resources } = await container.items
      .query<Thought>({
        query:
          'SELECT c.id, c.title, c.content, c.tags, c.owner, c.createdBy, c.createdAt, c.modifiedBy, c.modifiedAt ' +
          'FROM c WHERE c.owner = @owner AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false) ORDER BY c.modifiedAt DESC',
        parameters: [{ name: '@owner', value: email }],
      })
      .fetchAll();
    const all = resources.map(({ contentVector: _v, ...t }) => t as Thought);

    const matching = filter.length
      ? all.filter((t) => {
          const tags = new Set((t.tags ?? []).map((tag) => tag.toLowerCase()));
          return filter.every((tag) => tags.has(tag));
        })
      : all;

    const page: ThoughtPage = {
      items: matching.slice(offset, offset + limit),
      total: matching.length,
      tags: tagCounts(all),
    };
    res.json(page);
  } catch (err) {
    console.error('Error fetching thoughts:', err);
    res.status(500).json({ error: 'Failed to fetch thoughts' });
  }
});

// POST create thought
router.post('/', async (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const email = req.user!.email;
    const thought: Thought = {
      id: randomUUID(),
      title: req.body.title ?? undefined,
      content: req.body.content ?? '',
      tags: normalizeThoughtTags(req.body.tags),
      owner: email,
      createdBy: email,
      createdAt: now,
      modifiedBy: email,
      modifiedAt: now,
    };
    if (!thought.content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    try {
      thought.contentVector = await generateEmbedding(embeddingText(thought));
    } catch (embErr) {
      console.warn('thoughts: embedding generation failed, storing without vector:', embErr);
    }
    const { resource } = await container.items.create<Thought>(thought);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating thought:', err);
    res.status(500).json({ error: 'Failed to create thought' });
  }
});

// PUT update thought
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Thought>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Thought not found' });
      return;
    }
    const updated: Thought = {
      ...existing,
      title: req.body.title ?? existing.title,
      content: req.body.content ?? existing.content,
      tags: req.body.tags === undefined ? existing.tags : normalizeThoughtTags(req.body.tags),
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    };
    // Tags aren't embedded, so a tag-only edit keeps the existing vector.
    if (!existing.contentVector || embeddingText(updated) !== embeddingText(existing)) {
      try {
        updated.contentVector = await generateEmbedding(embeddingText(updated));
      } catch (embErr) {
        console.warn('thoughts: embedding generation failed, keeping existing vector:', embErr);
      }
    }
    const { resource } = await container.item(id, id).replace<Thought>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error updating thought:', err);
    res.status(500).json({ error: 'Failed to update thought' });
  }
});

// PATCH restore thought (undo soft delete)
router.patch('/:id/restore', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Thought>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Thought not found' });
      return;
    }
    const { resource } = await container.item(id, id).replace<Thought>({
      ...existing,
      deleted: false,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    });
    res.json(resource);
  } catch (err) {
    console.error('Error restoring thought:', err);
    res.status(500).json({ error: 'Failed to restore thought' });
  }
});

// DELETE thought (soft delete)
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<Thought>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Thought not found' });
      return;
    }
    await container.item(id, id).replace<Thought>({
      ...existing,
      deleted: true,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    });
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting thought:', err);
    res.status(500).json({ error: 'Failed to delete thought' });
  }
});

export default router;
