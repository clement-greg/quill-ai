import { Router, Request, Response } from 'express';
import { getContainer } from '../cosmos';
import { generateEmbedding } from '../embeddings';
import { Chapter } from '../../shared/models/chapter.model';
import { Book } from '../../shared/models/book.model';
import { Series } from '../../shared/models/series.model';
import { withOwnerFilter, readOwnedItem, readAccessibleItem } from '../owner-guard';

const router = Router();
const container = getContainer('chapters');
const booksContainer = getContainer('books');
const seriesContainer = getContainer('series');

/** Returns true if the user has owner or collaborator access to the series containing the given book. */
async function canAccessBook(bookId: string, req: import('express').Request): Promise<boolean> {
  const { resource: book } = await booksContainer.item(bookId, bookId).read<Book>();
  if (!book) return false;
  const series = await readAccessibleItem<Series>(seriesContainer, book.seriesId, book.seriesId, req);
  return series !== null;
}

// GET all chapters
router.get('/', async (req: Request, res: Response) => {
  try {
    const { resources } = await container.items
      .query(withOwnerFilter(req, 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.archived) OR c.archived = false)'))
      .fetchAll();
    res.json(resources as Chapter[]);
  } catch (err) {
    console.error('Error fetching chapters:', err);
    res.status(500).json({ error: 'Failed to fetch chapters' });
  }
});

// GET all archived chapters
router.get('/archived', async (req: Request, res: Response) => {
  try {
    const { resources } = await container.items
      .query(withOwnerFilter(req, 'SELECT * FROM c WHERE c.archived = true'))
      .fetchAll();
    res.json(resources as Chapter[]);
  } catch (err) {
    console.error('Error fetching archived chapters:', err);
    res.status(500).json({ error: 'Failed to fetch archived chapters' });
  }
});

// GET chapters by book
router.get('/book/:bookId', async (req: Request, res: Response) => {
  try {
    const bookId = req.params['bookId'] as string;
    const hasAccess = await canAccessBook(bookId, req);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const { resources } = await container.items
      .query({
        query: 'SELECT * FROM c WHERE c.bookId = @bookId AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
        parameters: [{ name: '@bookId', value: bookId }],
      })
      .fetchAll();
    res.json(resources as Chapter[]);
  } catch (err) {
    console.error('Error fetching chapters by book:', err);
    res.status(500).json({ error: 'Failed to fetch chapters by book' });
  }
});

// GET single chapter by id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const resource = await container.item(id, id).read<Chapter>().then(r => r.resource);
    if (!resource) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const hasAccess = await canAccessBook(resource.bookId, req);
    if (!hasAccess) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    res.json(resource);
  } catch (err) {
    console.error('Error fetching chapter:', err);
    res.status(500).json({ error: 'Failed to fetch chapter' });
  }
});

// POST create new chapter
router.post('/', async (req: Request, res: Response) => {
  try {
    const chapter: Chapter = req.body;
    if (!chapter.title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    if (!chapter.bookId) {
      res.status(400).json({ error: 'Book is required' });
      return;
    }
    if (chapter.content) {
      try {
        chapter.contentVector = await generateEmbedding(chapter.content);
      } catch (embErr) {
        console.error('Failed to generate embedding for new chapter:', embErr);
      }
    }
    const now = new Date().toISOString();
    chapter.owner = chapter.owner || req.user!.email;
    chapter.createdBy = req.user!.email;
    chapter.createdAt = now;
    chapter.modifiedBy = req.user!.email;
    chapter.modifiedAt = now;
    const { resource } = await container.items.create<Chapter>(chapter);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating chapter:', err);
    res.status(500).json({ error: 'Failed to create chapter' });
  }
});

// PATCH reorder chapters
router.patch('/reorder', async (req: Request, res: Response) => {
  try {
    const items: { id: string; sortOrder: number }[] = req.body;
    await Promise.all(
      items.map(async ({ id, sortOrder }) => {
        const { resource } = await container.item(id, id).read<Chapter>();
        if (resource) {
          await container.item(id, id).replace<Chapter>({ ...resource, sortOrder });
        }
      })
    );
    res.status(204).send();
  } catch (err) {
    console.error('Error reordering chapters:', err);
    res.status(500).json({ error: 'Failed to reorder chapters' });
  }
});

// PUT update chapter
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const chapter: Chapter = { ...req.body, id, owner: req.body.owner || req.user!.email, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    if (chapter.content) {
      try {
        chapter.contentVector = await generateEmbedding(chapter.content);
      } catch (embErr) {
        console.error('Failed to generate embedding for chapter update:', embErr);
      }
    } else {
      delete chapter.contentVector;
    }
    const { resource } = await container.item(id, id).replace<Chapter>(chapter);
    res.json(resource);
  } catch (err) {
    console.error('Error updating chapter:', err);
    res.status(500).json({ error: 'Failed to update chapter' });
  }
});

// PATCH archive chapter
router.patch('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { resource: existing } = await container.item(id, id).read<Chapter>();
    if (!existing) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const hasAccess = await canAccessBook(existing.bookId, req);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const updated: Chapter = { ...existing, archived: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Chapter>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error archiving chapter:', err);
    res.status(500).json({ error: 'Failed to archive chapter' });
  }
});

// PATCH unarchive chapter
router.patch('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { resource: existing } = await container.item(id, id).read<Chapter>();
    if (!existing) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const hasAccess = await canAccessBook(existing.bookId, req);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const updated: Chapter = { ...existing, archived: false, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Chapter>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error unarchiving chapter:', err);
    res.status(500).json({ error: 'Failed to unarchive chapter' });
  }
});

// DELETE chapter
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    await container.item(id, id).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting chapter:', err);
    res.status(500).json({ error: 'Failed to delete chapter' });
  }
});

export default router;
