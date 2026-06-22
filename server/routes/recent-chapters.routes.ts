import { Router, Request, Response } from 'express';
import { getContainer } from '../cosmos';
import { RecentChapter } from '../../shared/models/recent-chapter.model';

const router = Router();
const MAX_ITEMS = 4;

async function readSettings(userSub: string): Promise<Record<string, unknown>> {
  try {
    const container = getContainer('user-settings');
    const { resource } = await container.item(userSub, userSub).read<Record<string, unknown>>();
    return resource ?? {};
  } catch (err: any) {
    if (err.code === 404) return {};
    throw err;
  }
}

// GET /api/recent-chapters
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const settings = await readSettings(user.sub);
    res.json((settings.recentChapters as RecentChapter[] | undefined) ?? []);
  } catch (err) {
    console.error('[recent-chapters] GET error:', err);
    res.status(500).json({ error: 'Failed to load recent chapters' });
  }
});

// POST /api/recent-chapters — record a single chapter visit.
// The merge happens server-side against the persisted list, so a client with a
// stale or empty in-memory cache can never overwrite the saved history.
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const entry = req.body as Partial<RecentChapter>;
    if (!entry?.chapterId) {
      res.status(400).json({ error: 'chapterId is required' });
      return;
    }

    const container = getContainer('user-settings');
    const existing = await readSettings(user.sub);
    const current = (existing.recentChapters as RecentChapter[] | undefined) ?? [];

    const visited: RecentChapter = {
      chapterId: entry.chapterId,
      chapterTitle: entry.chapterTitle ?? 'Chapter',
      bookTitle: entry.bookTitle ?? '',
      seriesTitle: entry.seriesTitle ?? '',
      thumbnailUrl: entry.thumbnailUrl,
      visitedAt: Date.now(),
    };

    const recentChapters = [visited, ...current.filter(c => c.chapterId !== visited.chapterId)]
      .slice(0, MAX_ITEMS);

    await container.items.upsert({ ...existing, id: user.sub, recentChapters });
    res.json(recentChapters);
  } catch (err) {
    console.error('[recent-chapters] POST error:', err);
    res.status(500).json({ error: 'Failed to record recent chapter' });
  }
});

// DELETE /api/recent-chapters/:chapterId — remove a single entry server-side.
router.delete('/:chapterId', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const { chapterId } = req.params;

    const container = getContainer('user-settings');
    const existing = await readSettings(user.sub);
    const current = (existing.recentChapters as RecentChapter[] | undefined) ?? [];
    const recentChapters = current.filter(c => c.chapterId !== chapterId);

    await container.items.upsert({ ...existing, id: user.sub, recentChapters });
    res.json(recentChapters);
  } catch (err) {
    console.error('[recent-chapters] DELETE error:', err);
    res.status(500).json({ error: 'Failed to remove recent chapter' });
  }
});

export default router;
