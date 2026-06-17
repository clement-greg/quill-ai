import { Router, Request, Response } from 'express';
import { downloadBlob } from '../storage';
import { generateImage } from '../image-generation';

const router = Router();

// POST /api/image/generate  — { prompt: string, provider?: 'gpt' | 'gemini' } → { url, thumbnailUrl }
router.post('/generate', async (req: Request, res: Response) => {
  const { prompt, provider = 'gpt' } = req.body as { prompt?: string; provider?: 'gpt' | 'gemini' };
  if (!prompt?.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  try {
    const result = await generateImage(prompt, provider);
    res.json(result);
  } catch (err) {
    console.error('Image generate error:', err);
    res.status(502).json({ error: 'Image generation failed' });
  }
});

// GET /api/image/:filename
router.get('/:filename', async (req: Request, res: Response) => {
  const filename = Array.isArray(req.params['filename'])
    ? req.params['filename'][0]
    : req.params['filename'];

  // Only allow safe filenames — no path traversal
  if (!filename || /[/\\]/.test(filename)) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  try {
    const { data, contentType } = await downloadBlob(filename);
    // Cache in the browser for 1 year (blobs are UUID-named and immutable)
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Length', data.length);
    res.send(data);
  } catch (err: any) {
    if (err?.statusCode === 404) {
      res.status(404).json({ error: 'Image not found' });
    } else {
      console.error('Image proxy error:', err);
      res.status(500).json({ error: 'Failed to retrieve image' });
    }
  }
});

export default router;
