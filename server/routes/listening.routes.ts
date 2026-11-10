import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import { ListeningPosition } from '../../shared/models/listening.model';

const router = Router();

/** Books remembered per user; the least recently played fall off. */
const MAX_BOOKS = 50;

/**
 * Listening positions live in the user-settings container (the database is at
 * its container ceiling) as a second document per user, keyed apart from the
 * settings document. It deliberately has no `email` field, so the by-email
 * settings lookups (avatar, AI models) never match it.
 */
interface ListeningDoc {
  id: string;
  books: Record<string, ListeningPosition>;
}

const docId = (sub: string) => `listening::${sub}`;

async function readDoc(sub: string): Promise<ListeningDoc> {
  const id = docId(sub);
  try {
    const { resource } = await getContainer('user-settings').item(id, id).read<ListeningDoc>();
    return resource ?? { id, books: {} };
  } catch (err: any) {
    if (err.code === 404) return { id, books: {} };
    throw err;
  }
}

const isText = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;

/** Builds a stored position from a request body, or null if it's malformed. */
function parsePosition(bookId: string, body: any): ListeningPosition | null {
  if (!body || typeof body !== 'object') return null;
  const { bookTitle, chapterId, chapterTitle, blockIndex, progress, coverUrl, finished } = body;
  if (!isText(bookTitle, 500) || !isText(chapterId, 200) || !chapterId || !isText(chapterTitle, 500)) return null;
  if (!Number.isInteger(blockIndex) || blockIndex < -1) return null;
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  if (coverUrl !== undefined && !isText(coverUrl, 2000)) return null;
  if (finished !== undefined && typeof finished !== 'boolean') return null;
  return {
    bookId,
    bookTitle,
    chapterId,
    chapterTitle,
    blockIndex,
    progress: Math.min(1, Math.max(0, progress)),
    ...(coverUrl ? { coverUrl } : {}),
    ...(finished ? { finished: true } : {}),
    updatedAt: Date.now(),
  };
}

// GET /api/listening — every remembered book, most recently played first.
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const doc = await readDoc(req.user!.sub);
    res.json(Object.values(doc.books).sort((a, b) => b.updatedAt - a.updatedAt));
  } catch (err) {
    console.error('[listening] GET error:', err);
    res.status(500).json({ error: 'Failed to load listening positions' });
  }
});

// PUT /api/listening/:bookId — remember where the reader is in this book.
router.put('/:bookId', async (req: Request, res: Response): Promise<void> => {
  try {
    const bookId = req.params['bookId'] as string;
    const position = parsePosition(bookId, req.body);
    if (!position) {
      res.status(400).json({ error: 'Invalid listening position' });
      return;
    }
    const doc = await readDoc(req.user!.sub);
    const books = { ...doc.books, [bookId]: position };
    const kept = Object.values(books)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_BOOKS);
    await getContainer('user-settings').items.upsert<ListeningDoc>({
      id: doc.id,
      books: Object.fromEntries(kept.map(p => [p.bookId, p])),
    });
    res.json(position);
  } catch (err) {
    console.error('[listening] PUT error:', err);
    res.status(500).json({ error: 'Failed to save listening position' });
  }
});

export default router;
