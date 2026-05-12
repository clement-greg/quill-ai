import { Router, Request, Response } from 'express';
import { getContainer } from '../cosmos';

const router = Router();

interface UserSettings {
  id: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  darkMode?: boolean;
  ghostCompleteItems?: { id: string; label: string; prompt: string }[];
}

// GET /api/user-settings
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const container = getContainer('user-settings');
    const { resource } = await container.item(user.sub, user.sub).read<UserSettings>();
    if (!resource) {
      res.json({});
      return;
    }
    const { id: _id, ...settings } = resource;
    res.json(settings);
  } catch (err: any) {
    if (err.code === 404) {
      res.json({});
      return;
    }
    console.error('[user-settings] GET error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// PUT /api/user-settings
router.put('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const container = getContainer('user-settings');
    const settings: UserSettings = {
      id: user.sub,
      email: user.email,
      displayName: req.body.displayName,
      avatarUrl: req.body.avatarUrl,
      darkMode: req.body.darkMode,
      ghostCompleteItems: req.body.ghostCompleteItems,
    };
    await container.items.upsert(settings);
    const { id: _id, ...result } = settings;
    res.json(result);
  } catch (err) {
    console.error('[user-settings] PUT error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
