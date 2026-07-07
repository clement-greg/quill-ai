import { Router, Request, Response } from 'express';
import { getContainer } from '../cosmos';
import { refreshRedactionTerms } from '../content-sanitize';

const router = Router();

const CONTENT_FILTER_SETTINGS_ID = 'content-filter';

interface ContentFilterSettings {
  id: string;
  terms: string[];
}

// GET /api/app-settings/content-filter-terms
router.get('/content-filter-terms', async (_req: Request, res: Response): Promise<void> => {
  try {
    const container = getContainer('app-settings');
    const { resource } = await container
      .item(CONTENT_FILTER_SETTINGS_ID, CONTENT_FILTER_SETTINGS_ID)
      .read<ContentFilterSettings>();
    res.json({ terms: resource?.terms ?? [] });
  } catch (err: any) {
    if (err.code === 404) {
      res.json({ terms: [] });
      return;
    }
    console.error('[app-settings] GET content-filter-terms error:', err);
    res.status(500).json({ error: 'Failed to load content filter terms' });
  }
});

// PUT /api/app-settings/content-filter-terms
router.put('/content-filter-terms', async (req: Request, res: Response): Promise<void> => {
  const { terms } = req.body;
  if (!Array.isArray(terms) || !terms.every(term => typeof term === 'string')) {
    res.status(400).json({ error: 'terms must be an array of strings' });
    return;
  }

  try {
    const container = getContainer('app-settings');
    const settings: ContentFilterSettings = { id: CONTENT_FILTER_SETTINGS_ID, terms };
    await container.items.upsert(settings);
    refreshRedactionTerms();
    res.json({ terms });
  } catch (err) {
    console.error('[app-settings] PUT content-filter-terms error:', err);
    res.status(500).json({ error: 'Failed to save content filter terms' });
  }
});

export default router;
