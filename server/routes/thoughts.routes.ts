import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getContainer } from '../cosmos';
import { generateEmbedding } from '../embeddings';
import { Thought } from '../../shared/models/thought.model';
import { readOwnedItem } from '../owner-guard';

const router = Router();
const container = getContainer('thought-items');

/** Builds the text to embed: title (if any) prepended to content. */
function embeddingText(thought: Pick<Thought, 'title' | 'content'>): string {
  return thought.title ? `${thought.title}\n\n${thought.content}` : thought.content;
}

// GET all thoughts for the current user
router.get('/', async (req: Request, res: Response) => {
  try {
    const email = req.user!.email;
    const { resources } = await container.items
      .query<Thought>({
        query:
          'SELECT * FROM c WHERE c.owner = @owner AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false) ORDER BY c.modifiedAt DESC',
        parameters: [{ name: '@owner', value: email }],
      })
      .fetchAll();
    res.json(resources);
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
      tags: req.body.tags ?? [],
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
      tags: req.body.tags ?? existing.tags,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    };
    try {
      updated.contentVector = await generateEmbedding(embeddingText(updated));
    } catch (embErr) {
      console.warn('thoughts: embedding generation failed, keeping existing vector:', embErr);
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
