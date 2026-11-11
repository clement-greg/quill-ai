import { Router, Request, Response } from 'express';
import {
  DEFAULT_AZURE_VOICE, listVoices, MAX_SYNTHESIS_CHARS, speechConfigured, SpeechServiceError, synthesize,
} from '../services/azure-speech';

const router = Router();

/** Azure short names: letters, digits, dashes (and a colon in some HD voices). */
const VOICE_PATTERN = /^[A-Za-z0-9:-]{3,100}$/;

function sendError(res: Response, err: unknown, what: string): void {
  if (err instanceof SpeechServiceError) {
    console.error(`[speech] ${what}:`, err.message);
    res.status(err.status).json({ error: err.status === 429 ? 'The speech service is busy. Try again shortly.' : 'The speech service ran into a problem.' });
    return;
  }
  console.error(`[speech] ${what}:`, err);
  res.status(500).json({ error: 'The speech service ran into a problem.' });
}

// GET /api/speech/voices — Microsoft neural voices, or enabled: false when Azure isn't set up.
router.get('/voices', async (_req: Request, res: Response): Promise<void> => {
  if (!speechConfigured()) {
    res.json({ enabled: false, defaultVoice: null, voices: [] });
    return;
  }
  try {
    res.json({ enabled: true, defaultVoice: DEFAULT_AZURE_VOICE, voices: await listVoices() });
  } catch (err) {
    sendError(res, err, 'voices');
  }
});

// POST /api/speech/synthesize { text, voice?, rate? } — MP3 audio of the text.
router.post('/synthesize', async (req: Request, res: Response): Promise<void> => {
  if (!speechConfigured()) {
    res.status(503).json({ error: 'Microsoft voices aren\'t set up on this server.' });
    return;
  }
  const { text, voice = DEFAULT_AZURE_VOICE, rate = 1 } = req.body ?? {};
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  if (text.length > MAX_SYNTHESIS_CHARS) {
    res.status(400).json({ error: `text must be at most ${MAX_SYNTHESIS_CHARS} characters` });
    return;
  }
  if (typeof voice !== 'string' || !VOICE_PATTERN.test(voice)) {
    res.status(400).json({ error: 'voice is invalid' });
    return;
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.5 || rate > 3) {
    res.status(400).json({ error: 'rate must be between 0.5 and 3' });
    return;
  }
  try {
    const audio = await synthesize(text, voice, rate);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(audio);
  } catch (err) {
    sendError(res, err, 'synthesize');
  }
});

export default router;
