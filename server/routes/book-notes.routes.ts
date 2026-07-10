import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import { BookNote } from '../../shared/models/book-note.model';
import { Book } from '../../shared/models/book.model';
import { Series } from '../../shared/models/series.model';
import { readOwnedItem, readAccessibleItem } from '../middleware/owner-guard';

const router = Router();
const container = getContainer('book-notes');
const booksContainer = getContainer('books');
const seriesContainer = getContainer('series');

/** Returns true if the user has owner or collaborator access to the series containing the given book. */
async function canAccessBook(bookId: string, req: Request): Promise<boolean> {
  const { resource: book } = await booksContainer.item(bookId, bookId).read<Book>();
  if (!book) return false;
  const series = await readAccessibleItem<Series>(seriesContainer, book.seriesId, book.seriesId, req);
  return series !== null;
}

// GET all notes for a book
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
        query: 'SELECT * FROM c WHERE c.bookId = @bookId ORDER BY c.sortOrder ASC',
        parameters: [{ name: '@bookId', value: bookId }],
      })
      .fetchAll();
    res.json(resources as BookNote[]);
  } catch (err) {
    console.error('Error fetching book notes:', err);
    res.status(500).json({ error: 'Failed to fetch book notes' });
  }
});

// POST create note
router.post('/', async (req: Request, res: Response) => {
  try {
    const note: BookNote = req.body;
    if (!note.bookId) {
      res.status(400).json({ error: 'bookId is required' });
      return;
    }
    const now = new Date().toISOString();
    note.owner = req.user!.email;
    note.createdBy = req.user!.email;
    note.createdAt = now;
    note.modifiedBy = req.user!.email;
    note.modifiedAt = now;
    const { resource } = await container.items.create<BookNote>(note);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating book note:', err);
    res.status(500).json({ error: 'Failed to create book note' });
  }
});

// PUT update note
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<BookNote>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }
    const updated: BookNote = {
      ...existing,
      content: req.body.content,
      sortOrder: req.body.sortOrder ?? existing.sortOrder,
      modifiedBy: req.user!.email,
      modifiedAt: new Date().toISOString(),
    };
    const { resource } = await container.item(id, id).replace<BookNote>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error updating book note:', err);
    res.status(500).json({ error: 'Failed to update book note' });
  }
});

// PATCH reorder
router.patch('/reorder', async (req: Request, res: Response) => {
  try {
    const items: { id: string; sortOrder: number }[] = req.body;
    await Promise.all(
      items.map(async ({ id, sortOrder }) => {
        const existing = await readOwnedItem<BookNote>(container, id, id, req);
        if (existing) {
          await container.item(id, id).replace<BookNote>({ ...existing, sortOrder });
        }
      })
    );
    res.status(204).send();
  } catch (err) {
    console.error('Error reordering book notes:', err);
    res.status(500).json({ error: 'Failed to reorder book notes' });
  }
});

// DELETE note
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const existing = await readOwnedItem<BookNote>(container, id, id, req);
    if (!existing) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }
    await container.item(id, id).delete();
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting book note:', err);
    res.status(500).json({ error: 'Failed to delete book note' });
  }
});

export default router;
