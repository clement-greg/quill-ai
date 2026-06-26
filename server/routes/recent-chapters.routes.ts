import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { getContainer } from '../cosmos';
import { ChapterVisit, RecentChapter } from '../../shared/models/recent-chapter.model';

const router = Router();
const MAX_ITEMS = 20;
// How many recent visits to scan when collapsing to distinct chapters. Bounds
// the query cost while staying well above MAX_ITEMS so revisits never hide an
// older distinct chapter that still belongs in the list.
const SCAN_LIMIT = 100;

// GET /api/recent-chapters — the most recent MAX_ITEMS distinct chapters.
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const container = getContainer('chapter-visits');
    const { resources } = await container.items
      .query<ChapterVisit>({
        query:
          'SELECT * FROM c WHERE c.userSub = @sub ORDER BY c.visitedAt DESC OFFSET 0 LIMIT @limit',
        parameters: [
          { name: '@sub', value: user.sub },
          { name: '@limit', value: SCAN_LIMIT },
        ],
      })
      .fetchAll();

    const seen = new Set<string>();
    const recent: RecentChapter[] = [];
    for (const v of resources) {
      if (seen.has(v.chapterId)) continue;
      seen.add(v.chapterId);
      recent.push({
        chapterId: v.chapterId,
        chapterTitle: v.chapterTitle,
        bookTitle: v.bookTitle,
        seriesTitle: v.seriesTitle,
        thumbnailUrl: v.thumbnailUrl,
        visitedAt: v.visitedAt,
      });
      if (recent.length >= MAX_ITEMS) break;
    }

    res.json(recent);
  } catch (err) {
    console.error('[recent-chapters] GET error:', err);
    res.status(500).json({ error: 'Failed to load recent chapters' });
  }
});

// POST /api/recent-chapters — record a chapter visit as a new, immutable row.
// Insert-only: never updates or deletes. History therefore cannot be clobbered
// by a stale client.
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const entry = req.body as Partial<ChapterVisit>;
    if (!entry?.chapterId) {
      res.status(400).json({ error: 'chapterId is required' });
      return;
    }

    const visit: ChapterVisit = {
      id: randomUUID(),
      userSub: user.sub,
      chapterId: entry.chapterId,
      chapterTitle: entry.chapterTitle ?? 'Chapter',
      bookTitle: entry.bookTitle ?? '',
      seriesTitle: entry.seriesTitle ?? '',
      thumbnailUrl: entry.thumbnailUrl,
      visitedAt: Date.now(),
    };

    await getContainer('chapter-visits').items.create(visit);
    res.status(201).json(visit);
  } catch (err) {
    console.error('[recent-chapters] POST error:', err);
    res.status(500).json({ error: 'Failed to record chapter visit' });
  }
});

export default router;
