import { Router, Request, Response } from 'express';
import { getContainer } from '../cosmos';
import { RecentChapter } from '../../shared/models/recent-chapter.model';

const router = Router();
const MAX_ITEMS = 5;

// GET /api/recent-chapters
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const container = getContainer('user-settings');
    const { resource } = await container.item(user.sub, user.sub).read<{ recentChapters?: RecentChapter[] }>();
    res.json(resource?.recentChapters ?? []);
  } catch (err: any) {
    if (err.code === 404) {
      res.json([]);
      return;
    }
    console.error('[recent-chapters] GET error:', err);
    res.status(500).json({ error: 'Failed to load recent chapters' });
  }
});

// PUT /api/recent-chapters
router.put('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const container = getContainer('user-settings');
    const chapters: RecentChapter[] = (req.body ?? []).slice(0, MAX_ITEMS);

    let existing: Record<string, unknown> = {};
    try {
      const { resource } = await container.item(user.sub, user.sub).read<Record<string, unknown>>();
      if (resource) existing = resource;
    } catch (err: any) {
      if (err.code !== 404) throw err;
    }

    await container.items.upsert({ ...existing, id: user.sub, recentChapters: chapters });
    res.json(chapters);
  } catch (err) {
    console.error('[recent-chapters] PUT error:', err);
    res.status(500).json({ error: 'Failed to save recent chapters' });
  }
});

export default router;
