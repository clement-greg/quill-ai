import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import { Book } from '../../shared/models/book.model';
import { withOwnerFilter, readOwnedItem, readAccessibleItem } from '../middleware/owner-guard';
import { Series } from '../../shared/models/series.model';

const router = Router();
const container = getContainer('books');
const seriesContainer = getContainer('series');

// GET all books
router.get('/', async (req: Request, res: Response) => {
  try {
    const { resources } = await container.items
      .query(withOwnerFilter(req, 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.archived) OR c.archived = false)'))
      .fetchAll();
    res.json(resources as Book[]);
  } catch (err) {
    console.error('Error fetching books:', err);
    res.status(500).json({ error: 'Failed to fetch books' });
  }
});

// GET all archived books
router.get('/archived', async (req: Request, res: Response) => {
  try {
    const { resources } = await container.items
      .query(withOwnerFilter(req, 'SELECT * FROM c WHERE c.archived = true AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)'))
      .fetchAll();
    res.json(resources as Book[]);
  } catch (err) {
    console.error('Error fetching archived books:', err);
    res.status(500).json({ error: 'Failed to fetch archived books' });
  }
});

// GET books by series
router.get('/series/:seriesId', async (req: Request, res: Response) => {
  try {
    const seriesId = req.params['seriesId'] as string;
    // Allow access if the user owns or is a collaborator on the series
    const series = await readAccessibleItem<Series>(seriesContainer, seriesId, seriesId, req);
    if (!series) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const { resources } = await container.items
      .query({
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
        parameters: [{ name: '@seriesId', value: seriesId }],
      })
      .fetchAll();
    res.json(resources as Book[]);
  } catch (err) {
    console.error('Error fetching books by series:', err);
    res.status(500).json({ error: 'Failed to fetch books by series' });
  }
});

// GET single book by id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const resource = await readAccessibleItem<Book>(container, id, id, req);
    if (!resource) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    res.json(resource);
  } catch (err) {
    console.error('Error fetching book:', err);
    res.status(500).json({ error: 'Failed to fetch book' });
  }
});

// POST create new book
router.post('/', async (req: Request, res: Response) => {
  try {
    const book: Book = req.body;
    if (!book.title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    if (!book.seriesId) {
      res.status(400).json({ error: 'Series is required' });
      return;
    }
    const now = new Date().toISOString();
    book.owner = book.owner || req.user!.email;
    book.createdBy = req.user!.email;
    book.createdAt = now;
    book.modifiedBy = req.user!.email;
    book.modifiedAt = now;
    const { resource } = await container.items.create<Book>(book);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating book:', err);
    res.status(500).json({ error: 'Failed to create book' });
  }
});

// PATCH reorder books
router.patch('/reorder', async (req: Request, res: Response) => {
  try {
    const items: { id: string; sortOrder: number }[] = req.body;
    await Promise.all(
      items.map(async ({ id, sortOrder }) => {
        const { resource } = await container.item(id, id).read<Book>();
        if (resource) {
          await container.item(id, id).replace<Book>({ ...resource, sortOrder });
        }
      })
    );
    res.status(204).send();
  } catch (err) {
    console.error('Error reordering books:', err);
    res.status(500).json({ error: 'Failed to reorder books' });
  }
});

// PUT update book
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const book: Book = { ...req.body, id, owner: req.body.owner || req.user!.email, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Book>(book);
    res.json(resource);
  } catch (err) {
    console.error('Error updating book:', err);
    res.status(500).json({ error: 'Failed to update book' });
  }
});

// PATCH archive book
router.patch('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readAccessibleItem<Book>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    const updated: Book = { ...existing, archived: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Book>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error archiving book:', err);
    res.status(500).json({ error: 'Failed to archive book' });
  }
});

// PATCH unarchive book
router.patch('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readAccessibleItem<Book>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    const updated: Book = { ...existing, archived: false, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Book>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error unarchiving book:', err);
    res.status(500).json({ error: 'Failed to unarchive book' });
  }
});

// PATCH soft-delete book
router.patch('/:id/soft-delete', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readAccessibleItem<Book>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    const updated: Book = { ...existing, deleted: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Book>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error soft-deleting book:', err);
    res.status(500).json({ error: 'Failed to soft-delete book' });
  }
});

// PATCH restore soft-deleted book
router.patch('/:id/restore-delete', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readAccessibleItem<Book>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Book not found' });
      return;
    }
    const updated: Book = { ...existing, deleted: false, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Book>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error restoring book:', err);
    res.status(500).json({ error: 'Failed to restore book' });
  }
});

// DELETE book
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    await container.item(id, id).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting book:', err);
    res.status(500).json({ error: 'Failed to delete book' });
  }
});

export default router;
