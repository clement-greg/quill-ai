import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getContainer } from '../cosmos';

const router = Router();

// GET /api/avatar/:email
// Public endpoint — returns the profile picture for the given user email.
// Responds with the raw image bytes; uses ETags so the browser only re-downloads
// when the image actually changes, while a short max-age prevents hammering the DB.
router.get('/:email', async (req: Request, res: Response): Promise<void> => {
  const email = req.params['email'] as string;

  try {
    const container = getContainer('user-settings');
    const { resources } = await container.items
      .query<{ avatarUrl?: string }>({
        query: 'SELECT c.avatarUrl FROM c WHERE c.email = @email',
        parameters: [{ name: '@email', value: email }],
      })
      .fetchAll();

    const avatarUrl = resources[0]?.avatarUrl;
    if (!avatarUrl) {
      res.status(404).send();
      return;
    }

    // Parse "data:<contentType>;base64,<data>"
    const match = avatarUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      res.status(404).send();
      return;
    }

    const contentType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const etag = `"${crypto.createHash('md5').update(buffer).digest('hex')}"`;

    if (req.headers['if-none-match'] === etag) {
      res.status(304).send();
      return;
    }

    res.setHeader('Content-Type', contentType);
    // Cache for 5 minutes; always revalidate via ETag after that.
    res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
    res.setHeader('ETag', etag);
    res.send(buffer);
  } catch (err) {
    console.error('[avatar] GET error:', err);
    res.status(500).send();
  }
});

export default router;
