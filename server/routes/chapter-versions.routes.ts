import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getContainer } from '../services/cosmos';
import { ChapterVersion } from '../../shared/models/chapter.model';
import { withOwnerFilter } from '../middleware/owner-guard';

const router = Router();
const container = getContainer('chapter-versions');

// GET all versions for a chapter, ordered newest first
router.get('/chapter/:chapterId', async (req: Request, res: Response) => {
  try {
    const chapterId = req.params['chapterId'] as string;
    const { resources } = await container.items
      .query(withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.chapterId = @chapterId ORDER BY c.savedAt DESC',
        parameters: [{ name: '@chapterId', value: chapterId }],
      }), { partitionKey: chapterId })
      .fetchAll();
    res.json(resources as ChapterVersion[]);
  } catch (err) {
    console.error('Error fetching chapter versions:', err);
    res.status(500).json({ error: 'Failed to fetch chapter versions' });
  }
});

// POST create a new version snapshot
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<ChapterVersion>;
    if (!body.chapterId) {
      res.status(400).json({ error: 'chapterId is required' });
      return;
    }
    if (body.content === undefined) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    const version: ChapterVersion = {
      id: uuidv4(),
      chapterId: body.chapterId,
      savedAt: new Date().toISOString(),
      content: body.content,
      owner: req.user!.email,
      createdBy: req.user!.email,
      createdByName: body.createdByName,
    };
    const { resource } = await container.items.create<ChapterVersion>(version);
    res.status(201).json(resource);
  } catch (err) {
    console.error('Error creating chapter version:', err);
    res.status(500).json({ error: 'Failed to create chapter version' });
  }
});

export default router;
