import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';
import { downloadBlob } from '../services/storage';
import { generateImage } from '../services/image-generation';
import { sanitizeForModeration } from '../services/content-sanitize';
import { parseRange } from '../services/http-range';

const aiClient = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: config.foundry.apiVersion,
});

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

const SUGGEST_PROMPT_SYSTEM_PROMPT =
  'You write text-to-image prompts for the illustration that accompanies a chapter of a novel. ' +
  'From the chapter text you are given, pick the single most visually striking moment, setting, or ' +
  'object and describe it as one vivid image. Write 2-4 sentences covering subject, setting, ' +
  'lighting, mood, and art style. Do not name characters — describe them by appearance instead. ' +
  'No dialog, no plot narration, no spoilers of the ending in words. ' +
  'Return only the prompt text — no preamble, no quotes, no headings.';

/** Max characters of chapter prose sent to the model when suggesting a prompt. */
const SUGGEST_PROMPT_MAX_CHARS = 12000;

function isContentFilterError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'content_filter';
}

async function requestImagePrompt(userContent: string): Promise<string> {
  const completion = await aiClient.chat.completions.create({
    model: config.foundry.midModel,
    messages: [
      { role: 'system', content: SUGGEST_PROMPT_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() ?? '';
}

/**
 * Cheap 1-token probe to check whether a passage alone would be blocked by the
 * content filter, without paying for a full completion.
 * Must use the same tier as the real call — Azure content filters are
 * configured per deployment, so a probe on another tier proves nothing.
 */
async function isPromptSafe(input: string): Promise<boolean> {
  try {
    await aiClient.chat.completions.create({
      model: config.foundry.midModel,
      messages: [{ role: 'user', content: input }],
      max_completion_tokens: 1,
    });
    return true;
  } catch (err) {
    if (isContentFilterError(err)) return false;
    throw err;
  }
}

/**
 * Drops the paragraphs Azure's content filter objects to, so a chapter with one
 * violent scene can still be described. Mirrors the chapter-summary fallback.
 * Probes in small batches to keep latency down on long chapters.
 */
async function dropFilteredParagraphs(text: string): Promise<string[]> {
  const paragraphs = text.split('\n').filter(Boolean);
  const survivors: string[] = [];
  const BATCH = 8;
  for (let i = 0; i < paragraphs.length; i += BATCH) {
    const batch = paragraphs.slice(i, i + BATCH);
    const verdicts = await Promise.all(
      batch.map(async paragraph => {
        try {
          return await isPromptSafe(paragraph);
        } catch (err) {
          console.error('Content filter probe failed; keeping paragraph:', err);
          return true;
        }
      }),
    );
    batch.forEach((paragraph, j) => {
      if (verdicts[j]) survivors.push(paragraph);
    });
  }
  return survivors;
}

/** Strips HTML tags to plain text, collapsing whitespace. */
function toPlainText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// POST /api/image/suggest-prompt
//   { text: string, title?: string } → { prompt }
// Turns chapter prose into a text-to-image prompt the author can edit before generating.
router.post('/suggest-prompt', async (req: Request, res: Response) => {
  const { text, title } = req.body as { text?: string; title?: string };
  const plain = toPlainText(text ?? '');
  if (!plain) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const heading = title?.trim() ? `Chapter title: ${title.trim()}\n\n` : '';

  try {
    const excerpt = await sanitizeForModeration(plain.slice(0, SUGGEST_PROMPT_MAX_CHARS));

    let prompt: string;
    try {
      prompt = await requestImagePrompt(`${heading}Chapter text:\n${excerpt}`);
    } catch (err) {
      if (!isContentFilterError(err)) throw err;
      // The filter reacts to the scene as a whole; drop the paragraphs it
      // objects to so the rest of the chapter can still be described.
      console.warn('Image prompt input filtered; isolating offending paragraph(s).');
      const survivors = await dropFilteredParagraphs(excerpt);
      if (survivors.length === 0) {
        res.status(422).json({ error: 'This chapter\'s text was blocked by the content filter' });
        return;
      }
      prompt = await requestImagePrompt(`${heading}Chapter text:\n${survivors.join('\n')}`);
    }

    if (!prompt) {
      res.status(502).json({ error: 'Could not suggest a prompt' });
      return;
    }
    res.json({ prompt });
  } catch (err) {
    if (isContentFilterError(err)) {
      console.warn('Image prompt still filtered after omitting flagged paragraphs.');
      res.status(422).json({ error: 'This chapter\'s text was blocked by the content filter' });
      return;
    }
    console.error('Suggest image prompt error:', err);
    res.status(502).json({ error: 'Could not suggest a prompt' });
  }
});

// GET /api/image/:filename — also serves videos; both are decrypted here.
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
    // Videos need byte-range serving to seek — and Safari refuses to play a
    // <video> src at all unless the server advertises range support.
    res.setHeader('Accept-Ranges', 'bytes');

    const range = parseRange(req.headers.range, data.length);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${data.length}`);
      res.status(416).end();
      return;
    }

    if (range) {
      const slice = data.subarray(range.start, range.end + 1);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${data.length}`);
      res.setHeader('Content-Length', slice.length);
      res.status(206).send(slice);
      return;
    }

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
