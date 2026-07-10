import { Router, Request, Response } from 'express';
import { downloadBlob } from '../services/storage';
import { generateImage } from '../services/image-generation';

const router = Router();

// POST /api/image/generate
//   { prompt: string, referenceImageUrl?: string, transparentBackground?: boolean } → { url, thumbnailUrl }
// When referenceImageUrl is provided, its image is passed to the model as a
// reference so the generated image keeps the same face/body.
router.post('/generate', async (req: Request, res: Response) => {
  const { prompt, referenceImageUrl, transparentBackground } = req.body as {
    prompt?: string;
    referenceImageUrl?: string;
    transparentBackground?: boolean;
  };
  if (!prompt?.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  try {
    let referenceImage: { data: Buffer; mimeType: string } | undefined;
    if (referenceImageUrl?.trim()) {
      const filename = referenceImageUrl.split('/').pop();
      if (filename && !/[/\\]/.test(filename)) {
        try {
          const { data, contentType } = await downloadBlob(filename);
          referenceImage = { data, mimeType: contentType };
        } catch (err) {
          console.error('Failed to load reference image, generating without it:', err);
        }
      }
    }

    const result = await generateImage(prompt, referenceImage, { transparentBackground });
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
