import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import config from '../config';
import { uploadFileToBlob, downloadBlobRaw } from '../services/storage';
import { VIDEO_EXTENSIONS, isVideoUrl } from '../../shared/models/entity.model';
import {
  GenerationCancelResult,
  GenerationJob,
  GenerationJobProgress,
  GenerationQueueStatus,
} from '../../shared/models/generation-queue.model';

const router = Router();
const DEFAULT_THUMBNAIL_SIZE = 400; // max width or height in px for palette stamps

/** Raster formats every browser can display — stored byte-for-byte as uploaded. */
const WEB_SAFE_RASTER_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'];
/**
 * Raster formats we accept but re-encode to JPEG on the way in. HEIC is what an
 * iPhone hands over for a library photo, and only Safari can render it — storing
 * it as-is would upload fine and then show a broken image everywhere else.
 */
const TRANSCODE_RASTER_EXTS = ['.heic', '.heif', '.jfif', '.bmp', '.tif', '.tiff'];
const RASTER_EXTS = [...WEB_SAFE_RASTER_EXTS, ...TRANSCODE_RASTER_EXTS];
const SVG_EXTS = ['.svg'];
const VIDEO_EXTS = VIDEO_EXTENSIONS;

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
};

/**
 * Fallback extension when the upload arrives without a usable one — iOS share
 * sheets sometimes send a bare `image` or `file` as the name. The extension is
 * not cosmetic: blobs are stored as `<uuid><ext>` and isVideoUrl() reads the
 * stored URL's extension to tell a video from a photo.
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/heic-sequence': '.heic',
  'image/tiff': '.tif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/x-m4v': '.m4v',
};

const KNOWN_EXTS = [...RASTER_EXTS, ...SVG_EXTS, ...VIDEO_EXTS];

/** The extension to store this upload under, falling back to its MIME type. */
function resolveExt(originalname: string, mimetype: string): string {
  const ext = path.extname(originalname).toLowerCase();
  if (KNOWN_EXTS.includes(ext)) return ext;
  return EXT_BY_MIME[mimetype.toLowerCase()] ?? ext;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (videos are larger than images)
  fileFilter: (_req, file, cb) => {
    // Judge on the MIME type as well as the extension: a photo picked on iOS can
    // arrive with an unhelpful filename, and an extension-only test drops it.
    const mime = file.mimetype.toLowerCase();
    const ext = path.extname(file.originalname).toLowerCase();
    if (KNOWN_EXTS.includes(ext) || mime.startsWith('image/') || mime.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  },
});

// POST /api/upload  — multipart/form-data with field name "file"
// Optional query param: ?thumbSize=N overrides the default 400px max dimension (e.g. 1600 for map previews)
/**
 * Multer rejects (wrong type, over the size limit) surface as thrown errors. Without
 * this they reach Express's default handler, which answers with an HTML 500 that the
 * client can only report as a generic failure — so the upload appears to do nothing.
 */
function handleUploadErrors(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'That file is larger than the 50 MB limit' });
      return;
    }
    // Busboy's "Unexpected end of form" means the multipart body stopped arriving
    // before its closing boundary — the request died in flight rather than the
    // file being wrong. iOS does this when Safari cannot finish reading a photo
    // that is still in iCloud. It is worth retrying, so say so and flag it.
    if (err instanceof Error && /unexpected end of form/i.test(err.message)) {
      console.error('Upload truncated in transit:', err.message);
      res.status(400).json({
        code: 'TRUNCATED_UPLOAD',
        error: 'The photo did not finish uploading. If it is stored in iCloud, open it in Photos first, then try again.',
      });
      return;
    }
    console.error('Upload rejected:', err);
    res.status(400).json({ error: err instanceof Error ? err.message : 'Upload rejected' });
  });
}

router.post('/', handleUploadErrors, async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const thumbSize = Math.min(
      Math.max(parseInt(String(req.query['thumbSize'] ?? ''), 10) || DEFAULT_THUMBNAIL_SIZE, 100),
      4096
    );

    const ext = resolveExt(req.file.originalname, req.file.mimetype);
    const id = uuidv4();
    const mimeType = ext === '.svg' ? 'image/svg+xml' : req.file.mimetype;

    let originalUrl: string;
    let thumbnailUrl: string;

    if (VIDEO_EXTS.includes(ext) || req.file.mimetype.toLowerCase().startsWith('video/')) {
      // Videos can't be thumbnailed with sharp — upload once and reuse the URL for both.
      const videoMime = VIDEO_MIME_BY_EXT[ext] ?? req.file.mimetype;
      originalUrl = await uploadFileToBlob(req.file.buffer, `${id}${ext}`, videoMime);
      thumbnailUrl = originalUrl;
    } else if (SVG_EXTS.includes(ext)) {
      // SVGs are already scalable — upload once and use for both url and thumbnailUrl.
      originalUrl = await uploadFileToBlob(req.file.buffer, `${id}${ext}`, mimeType);
      thumbnailUrl = originalUrl;
    } else {
      // `.rotate()` bakes in the EXIF orientation phone cameras rely on; without
      // it, portrait shots come back on their side once the metadata is dropped.
      const transcode = TRANSCODE_RASTER_EXTS.includes(ext);
      const thumbnailFilename = `${id}_thumb.webp`;
      const thumbnailBuffer = await sharp(req.file.buffer)
        .rotate()
        .resize(thumbSize, thumbSize, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();

      const originalBuffer = transcode
        ? await sharp(req.file.buffer).rotate().jpeg({ quality: 90 }).toBuffer()
        : req.file.buffer;
      const originalFilename = transcode ? `${id}.jpg` : `${id}${ext}`;
      const originalMime = transcode ? 'image/jpeg' : mimeType;

      [originalUrl, thumbnailUrl] = await Promise.all([
        uploadFileToBlob(originalBuffer, originalFilename, originalMime),
        uploadFileToBlob(thumbnailBuffer, thumbnailFilename, 'image/webp'),
      ]);
    }

    res.json({ url: originalUrl, thumbnailUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

/** The longest motion prompt accepted; it travels to the receiver in a query string. */
const MAX_VIDEO_PROMPT_LENGTH = 2000;

/**
 * Frame rate of the receiver's workflow (the CreateVideo node in
 * workflow_i2v.json). Duration is chosen in the UI in seconds; frames are what
 * the generator actually takes, so the conversion happens here.
 */
const VIDEO_FPS = 16;
const MIN_VIDEO_SECONDS = 0.5;
const MAX_VIDEO_SECONDS = 8;

/**
 * Frames for a requested duration. Wan's temporal compression only accepts
 * 4n+1 frame counts (81, 121, 161, ...), so the raw count is snapped to the
 * nearest one — at 16 fps every half-second step lands on one exactly.
 */
function framesForSeconds(seconds: number): number {
  const raw = Math.round(seconds * VIDEO_FPS);
  return Math.max(5, Math.round((raw - 1) / 4) * 4 + 1);
}

/**
 * The receiver's image-to-video endpoint — `photoExportUrl` in config. It takes
 * the raw image bytes as the POST body with the prompt and start-frame name in
 * the query string, and answers with the queued ComfyUI job.
 */
function videoGenTarget(filename: string, prompt: string, frames: number | null): string | null {
  const base = config.photoExportUrl?.trim().replace(/\/+$/, '');
  if (!base) return null;
  const query = new URLSearchParams({ prompt, name: filename });
  // Omitted entirely when no duration was asked for, so the workflow's own
  // default length stands rather than this route inventing one.
  if (frames !== null) query.set('length', String(frames));
  return `${base}/generate?${query.toString()}`;
}

/**
 * How long to wait for the receiver to accept a job. It has to take the image
 * bytes and hand them to ComfyUI before it answers, so this is generous — but
 * without it a receiver that accepts the connection and then stalls would hang
 * the request until the OS gives up, leaving the UI with no answer at all.
 */
const RECEIVER_TIMEOUT_MS = 60_000;

/**
 * Turns a failed fetch into something worth showing a user. Node wraps socket
 * failures in a TypeError whose `cause` carries the real code, so the specific
 * problem — host not found, nothing listening, connection dropped — is only
 * visible one level down.
 */
function transportFailure(err: unknown): { status: number; error: string } {
  const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code ?? e?.code ?? '';

  // fetch() rejects with an AbortError when the AbortSignal.timeout fires.
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return {
      status: 504,
      error: `The receiver did not answer within ${RECEIVER_TIMEOUT_MS / 1000}s. The job may still have been queued — check ComfyUI before retrying.`,
    };
  }

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { status: 502, error: 'Cannot find the receiver — check the tunnel address is still valid.' };
    case 'ECONNREFUSED':
      return { status: 502, error: 'The receiver refused the connection — is it running?' };
    case 'ETIMEDOUT':
      return { status: 504, error: 'Timed out connecting to the receiver — the machine may be asleep or offline.' };
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return { status: 502, error: 'The connection to the receiver dropped mid-request. Try again.' };
    default:
      break;
  }

  if (/certificate|self.signed|CERT_/i.test(code)) {
    return { status: 502, error: 'The receiver rejected the TLS handshake (certificate problem).' };
  }

  const detail = code || e?.cause?.message || (err instanceof Error ? err.message : '');
  return {
    status: 502,
    error: detail ? `Could not reach the receiver (${detail})` : 'Could not reach the receiver.',
  };
}

/**
 * The reason the receiver gave, when it sent one, for showing in the UI.
 * `Response` here is fetch's, not Express's — hence the explicit global.
 */
async function receiverError(response: globalThis.Response): Promise<string> {
  const body = (await response.text().catch(() => '')).slice(0, 2000);
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // Not JSON — an HTML error page or a proxy's own message.
  }
  return `Receiver returned ${response.status}`;
}

/** What the receiver answers with when it has queued a job. */
interface QueuedJob {
  promptId: string | null;
  seed: number | null;
  queueNumber: number | null;
}

type RelayResult = { ok: true; job: QueuedJob } | { ok: false; status: number; error: string };

/**
 * The stored photo, exactly as stored — still encrypted at rest, no decryption
 * on the way out — so decrypting it is the receiver's job.
 */
async function readStoredPhoto(
  filename: string
): Promise<{ ok: true; data: Buffer; contentType: string } | { ok: false; status: number; error: string }> {
  try {
    // Raw, not downloadBlob(): the stored ciphertext is what goes over the wire.
    const { raw, contentType } = await downloadBlobRaw(filename);
    return { ok: true, data: raw, contentType };
  } catch (err: any) {
    // A storage failure is not a receiver failure — say which one broke.
    if (err?.statusCode === 404) return { ok: false, status: 404, error: 'Photo not found' };
    console.error('Generation could not read the photo:', err);
    return { ok: false, status: 502, error: 'Could not read the photo from storage' };
  }
}

/**
 * Posts the image bytes to one of the receiver's queueing endpoints and reads
 * back the job it queued. Shared by video and image generation — they differ
 * only in which url they address and what they put in its query string.
 *
 * The relay runs on the server rather than in the browser because the receiver
 * sends no CORS headers, so a fetch straight from the page could read neither
 * the blob nor the reply.
 */
async function queueOnReceiver(target: string, data: Buffer, contentType: string): Promise<RelayResult> {
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        // Dev tunnels answer an unrecognised client with an interstitial page
        // instead of forwarding the request; this opts out of it.
        'X-Tunnel-Skip-AntiPhishing-Page': 'true',
      },
      body: new Uint8Array(data),
      // A dev tunnel that is not anonymously accessible answers with a redirect
      // to a sign-in page. Following it would return a cheerful 200 of HTML and
      // look like a queued job, so treat any redirect as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(RECEIVER_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      console.error('Generation redirected to', response.headers.get('location'));
      return { ok: false, status: 502, error: 'Receiver requires sign-in — make the tunnel public' };
    }

    if (!response.ok) {
      const reason = await receiverError(response);
      console.error('Generation failed:', response.status, reason);
      return { ok: false, status: 502, error: reason };
    }

    // The receiver answers with the queued ComfyUI job; pass the identifiers on
    // so the job can be found in ComfyUI without re-deriving them here.
    const job = (await response.json().catch(() => null)) as
      | { prompt_id?: string; seed?: number; queue_number?: number }
      | null;

    return {
      ok: true,
      job: {
        promptId: job?.prompt_id ?? null,
        seed: job?.seed ?? null,
        queueNumber: job?.queue_number ?? null,
      },
    };
  } catch (err) {
    const failure = transportFailure(err);
    console.error('Generation transport error:', failure.error, err);
    return { ok: false, status: failure.status, error: failure.error };
  }
}

/**
 * The stored photo this job starts from, or the reason it cannot be used. Both
 * generators take one gallery photo by its stored url; blobs are named
 * `<uuid><ext>`, so anything with a path separator in it did not come from us.
 */
function startFrameName(url: unknown): { ok: true; filename: string } | { ok: false; error: string } {
  const filename = (typeof url === 'string' ? url : '').split('/').pop() ?? '';
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return { ok: false, error: 'Invalid photo url' };
  if (isVideoUrl(filename)) return { ok: false, error: 'Only photos can be used as a start frame' };
  return { ok: true, filename };
}

/**
 * POST /api/upload/generate-video  { url, prompt, durationSeconds? }
 *   →  { promptId, seed, queueNumber, frames }
 *
 * Queues an image-to-video job on the external receiver, using one stored photo
 * as the start frame. See queueOnReceiver() for how the bytes get there.
 */
router.post('/generate-video', async (req: Request, res: Response) => {
  const source = startFrameName(req.body?.url);
  if (!source.ok) {
    res.status(400).json({ error: source.error });
    return;
  }
  const filename = source.filename;
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!prompt) {
    res.status(400).json({ error: 'A prompt is required' });
    return;
  }
  if (prompt.length > MAX_VIDEO_PROMPT_LENGTH) {
    res.status(400).json({ error: `Prompt must be ${MAX_VIDEO_PROMPT_LENGTH} characters or fewer` });
    return;
  }

  const rawSeconds = req.body?.durationSeconds;
  let frames: number | null = null;
  if (rawSeconds !== undefined && rawSeconds !== null && rawSeconds !== '') {
    const seconds = Number(rawSeconds);
    if (!Number.isFinite(seconds) || seconds < MIN_VIDEO_SECONDS || seconds > MAX_VIDEO_SECONDS) {
      res.status(400).json({
        error: `Duration must be between ${MIN_VIDEO_SECONDS} and ${MAX_VIDEO_SECONDS} seconds`,
      });
      return;
    }
    frames = framesForSeconds(seconds);
  }

  const target = videoGenTarget(filename, prompt, frames);
  if (!target) {
    res.status(503).json({ error: 'No video receiver configured (photoExportUrl)' });
    return;
  }

  const photo = await readStoredPhoto(filename);
  if (!photo.ok) {
    res.status(photo.status).json({ error: photo.error });
    return;
  }

  const result = await queueOnReceiver(target, photo.data, photo.contentType);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json({ ...result.job, frames });
});


/** Prompts travel to the receiver in a query string, so both are bounded. */
const MAX_IMAGE_PROMPT_LENGTH = 2000;

/** Images per run. The receiver's own default is 3; its ceiling is 12. */
const DEFAULT_IMAGE_COUNT = 3;
const MAX_IMAGE_COUNT = 12;

/**
 * The advanced settings the receiver's /faceid workflow will take, and the range
 * each is accepted in. Everything here is optional: a field left out keeps the
 * workflow's own value rather than this route inventing one. Keyed by the name
 * the request body uses, valued by the receiver's snake_case query parameter.
 */
const IMAGE_GEN_NUMBERS: Record<string, { param: string; min: number; max: number; integer: boolean }> = {
  width: { param: 'width', min: 64, max: 2048, integer: true },
  height: { param: 'height', min: 64, max: 2048, integer: true },
  steps: { param: 'steps', min: 1, max: 150, integer: true },
  cfg: { param: 'cfg', min: 0, max: 30, integer: false },
  seed: { param: 'seed', min: 0, max: 4294967295, integer: true },
};

/** Treats an absent, null, or empty value as "not asked for" rather than as 0. */
function omitted(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The receiver's IPAdapter FaceID endpoint — the same `photoExportUrl` base as
 * /generate. It takes the raw image bytes as the POST body with the prompt and
 * every setting in the query string, and answers with the queued ComfyUI job.
 */
function imageGenTarget(query: URLSearchParams): string | null {
  const base = config.photoExportUrl?.trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/faceid?${query.toString()}`;
}

/**
 * POST /api/upload/generate-images
 *   { url, prompt, count?, negativePrompt?, width?, height?, steps?, cfg?, seed? }
 *   →  { promptId, seed, queueNumber, count }
 *
 * Queues a batch of stills on the external receiver, keeping the face from one
 * stored photo (IPAdapter FaceID) and following the prompt for everything else.
 * The same relay as /generate-video, addressed at the receiver's /faceid.
 */
router.post('/generate-images', async (req: Request, res: Response) => {
  const source = startFrameName(req.body?.url);
  if (!source.ok) {
    res.status(400).json({ error: source.error });
    return;
  }
  const filename = source.filename;
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!prompt) {
    res.status(400).json({ error: 'A prompt is required' });
    return;
  }
  if (prompt.length > MAX_IMAGE_PROMPT_LENGTH) {
    res.status(400).json({ error: `Prompt must be ${MAX_IMAGE_PROMPT_LENGTH} characters or fewer` });
    return;
  }

  const negativePrompt =
    typeof req.body?.negativePrompt === 'string' ? req.body.negativePrompt.trim() : '';
  if (negativePrompt.length > MAX_IMAGE_PROMPT_LENGTH) {
    res.status(400).json({
      error: `Negative prompt must be ${MAX_IMAGE_PROMPT_LENGTH} characters or fewer`,
    });
    return;
  }

  let count = DEFAULT_IMAGE_COUNT;
  if (!omitted(req.body?.count)) {
    count = Number(req.body.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGE_COUNT) {
      res.status(400).json({ error: `Number of images must be between 1 and ${MAX_IMAGE_COUNT}` });
      return;
    }
  }

  const query = new URLSearchParams({ prompt, name: filename, batch_size: String(count) });
  // Sent only when it has something in it — an empty one would replace the
  // workflow's own negative prompt with nothing.
  if (negativePrompt) query.set('negative_prompt', negativePrompt);

  for (const [field, spec] of Object.entries(IMAGE_GEN_NUMBERS)) {
    const raw = req.body?.[field];
    if (omitted(raw)) continue;
    const value = Number(raw);
    const valid = spec.integer ? Number.isInteger(value) : Number.isFinite(value);
    if (!valid || value < spec.min || value > spec.max) {
      res.status(400).json({ error: `${field} must be between ${spec.min} and ${spec.max}` });
      return;
    }
    query.set(spec.param, String(value));
  }

  const target = imageGenTarget(query);
  if (!target) {
    res.status(503).json({ error: 'No image receiver configured (photoExportUrl)' });
    return;
  }

  const photo = await readStoredPhoto(filename);
  if (!photo.ok) {
    res.status(photo.status).json({ error: photo.error });
    return;
  }

  const result = await queueOnReceiver(target, photo.data, photo.contentType);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.json({ ...result.job, count });
});


/**
 * The receiver's queue endpoints. Both live on `photoExportUrl` alongside
 * /generate; null when no receiver is configured.
 */
function receiverUrl(path: string, query?: Record<string, string>): string | null {
  const base = config.photoExportUrl?.trim().replace(/\/+$/, '');
  if (!base) return null;
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  return `${base}${path}${search}`;
}

/** Reading or cancelling a queue entry is a small call — no image bytes move. */
const QUEUE_TIMEOUT_MS = 30_000;

/** The header every receiver call needs; see the notes on /generate-video. */
const RECEIVER_HEADERS = { 'X-Tunnel-Skip-AntiPhishing-Page': 'true' };

/** One queue entry as the receiver reports it (receiver/server.py). */
interface ReceiverJob {
  prompt_id?: string;
  queue_number?: number | null;
  start_image?: string | null;
  mine?: boolean;
  queued_at?: string | null;
  started_at?: string | null;
  position?: number;
  elapsed_seconds?: number;
  percent_complete?: number | null;
  estimated_total_seconds?: number | null;
  eta_seconds?: number | null;
  starts_in_seconds?: number | null;
  settings?: Record<string, number>;
  progress_source?: string;
  progress?: {
    source?: string;
    percent_complete?: number;
    steps_done?: number;
    steps_total?: number;
    updated_seconds_ago?: number | null;
    current_node?: {
      id?: string;
      class_type?: string | null;
      value?: number | null;
      max?: number | null;
    };
  };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Step-level progress off the receiver's websocket feed. Absent for a job the
 * receiver did not queue — ComfyUI addresses progress to the submitting client
 * — so a job with no counts is normal, not an error.
 */
function toProgress(raw: ReceiverJob['progress']): GenerationJobProgress | null {
  if (!raw) return null;
  const total = num(raw.steps_total);
  if (total === null || total <= 0) return null;
  const node = raw.current_node;
  return {
    source: typeof raw.source === 'string' ? raw.source : 'websocket',
    percentComplete: num(raw.percent_complete) ?? 0,
    stepsDone: num(raw.steps_done) ?? 0,
    stepsTotal: total,
    updatedSecondsAgo: num(raw.updated_seconds_ago),
    currentNode: node?.id
      ? {
          id: String(node.id),
          classType: typeof node.class_type === 'string' ? node.class_type : null,
          value: num(node.value),
          max: num(node.max),
        }
      : null,
  };
}

/** The receiver's own word on where a percentage came from. */
function toProgressSource(raw: string | undefined): GenerationJob['progressSource'] {
  return raw === 'websocket' || raw === 'elapsed-estimate' || raw === 'unknown' ? raw : null;
}

function toJob(raw: ReceiverJob, state: 'running' | 'pending'): GenerationJob {
  const s = raw.settings ?? {};
  return {
    promptId: raw.prompt_id ?? '',
    queueNumber: num(raw.queue_number),
    state,
    startImage: raw.start_image ?? null,
    // The receiver echoes a prompt back for its own jobs; it is dropped here so
    // it never reaches the queue screen.
    mine: raw.mine === true,
    queuedAt: raw.queued_at ?? null,
    startedAt: raw.started_at ?? null,
    settings: {
      ...(num(s['width']) !== null && { width: s['width'] }),
      ...(num(s['height']) !== null && { height: s['height'] }),
      ...(num(s['length']) !== null && { length: s['length'] }),
      ...(num(s['fps']) !== null && { fps: s['fps'] }),
      ...(num(s['steps']) !== null && { steps: s['steps'] }),
      ...(num(s['cfg']) !== null && { cfg: s['cfg'] }),
      ...(num(s['seed']) !== null && { seed: s['seed'] }),
      ...(num(s['batch_size']) !== null && { batchSize: s['batch_size'] }),
    },
    position: num(raw.position),
    elapsedSeconds: num(raw.elapsed_seconds),
    percentComplete: num(raw.percent_complete),
    progress: toProgress(raw.progress),
    progressSource: state === 'running' ? toProgressSource(raw.progress_source) : null,
    estimatedTotalSeconds: num(raw.estimated_total_seconds),
    etaSeconds: num(raw.eta_seconds),
    startsInSeconds: num(raw.starts_in_seconds),
  };
}

/**
 * GET /api/upload/generation-queue  ->  GenerationQueueStatus
 *
 * What the receiver has queued right now: the running job with a progress
 * estimate, then everything waiting behind it. Relayed through the server for
 * the same reason /generate-video is — the receiver sends no CORS headers.
 */
router.get('/generation-queue', async (_req: Request, res: Response) => {
  const target = receiverUrl('/queue');
  if (!target) {
    res.status(503).json({ error: 'No video receiver configured (photoExportUrl)' });
    return;
  }

  try {
    const response = await fetch(target, {
      headers: RECEIVER_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(QUEUE_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      res.status(502).json({ error: 'Receiver requires sign-in — make the tunnel public' });
      return;
    }
    if (!response.ok) {
      const reason = await receiverError(response);
      console.error('Queue status failed:', response.status, reason);
      res.status(502).json({ error: reason });
      return;
    }

    const body = (await response.json().catch(() => null)) as any;
    if (!body || typeof body !== 'object') {
      res.status(502).json({ error: 'The receiver sent an unreadable queue status' });
      return;
    }

    // Running first, then the pending items in queue order: one list is what the
    // screen renders, and the running job is always the head of the line.
    const running: ReceiverJob[] = Array.isArray(body.running) ? body.running : [];
    const pending: ReceiverJob[] = Array.isArray(body.pending) ? body.pending : [];
    const jobs = [
      ...running.map((j) => toJob(j, 'running')),
      ...pending.map((j) => toJob(j, 'pending')),
    ].filter((j) => j.promptId);

    const status: GenerationQueueStatus = {
      counts: {
        running: num(body.counts?.running) ?? running.length,
        pending: num(body.counts?.pending) ?? pending.length,
        total: num(body.counts?.total) ?? jobs.length,
      },
      jobs,
      queue: {
        percentComplete: num(body.queue?.percent_complete) ?? 0,
        estimatedSecondsRemaining: num(body.queue?.estimated_seconds_remaining) ?? 0,
        idle: body.queue?.idle === true || jobs.length === 0,
      },
      estimateBasis: {
        secondsPerFrame: num(body.estimate_basis?.seconds_per_frame) ?? 0,
        measured: body.estimate_basis?.measured === true,
        note: typeof body.estimate_basis?.note === 'string' ? body.estimate_basis.note : '',
      },
      progressFeed: {
        connected: body.progress_feed?.connected === true,
        messages: num(body.progress_feed?.messages),
        error: typeof body.progress_feed?.error === 'string' ? body.progress_feed.error : null,
        note: typeof body.progress_feed?.note === 'string' ? body.progress_feed.note : '',
      },
    };

    res.json(status);
  } catch (err) {
    const failure = transportFailure(err);
    console.error('Queue status transport error:', failure.error, err);
    res.status(failure.status).json({ error: failure.error });
  }
});

/**
 * DELETE /api/upload/generation-queue/:promptId  ->  GenerationCancelResult
 *
 * Takes one job out of the queue. The receiver decides how: a job still waiting
 * is deleted, the one running is interrupted. Its 404 (no such job) and 409
 * (already finished) are passed through as they are — both mean "nothing to
 * cancel", and the screen says which.
 */
router.delete('/generation-queue/:promptId', async (req: Request, res: Response) => {
  const promptId = String(req.params['promptId'] ?? '').trim();
  // Prompt ids are ComfyUI uuids; anything else never came from a queue listing.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(promptId)) {
    res.status(400).json({ error: 'Invalid prompt id' });
    return;
  }

  const target = receiverUrl('/cancel', { prompt_id: promptId });
  if (!target) {
    res.status(503).json({ error: 'No video receiver configured (photoExportUrl)' });
    return;
  }

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: RECEIVER_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(QUEUE_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      res.status(502).json({ error: 'Receiver requires sign-in — make the tunnel public' });
      return;
    }
    if (!response.ok) {
      const reason = await receiverError(response);
      console.error('Cancel failed:', promptId, response.status, reason);
      // 404/409 are the receiver's verdict on this job, not a relay failure.
      const status = response.status === 404 || response.status === 409 ? response.status : 502;
      res.status(status).json({ error: reason });
      return;
    }

    const body = (await response.json().catch(() => null)) as
      | { prompt_id?: string; cancelled?: boolean; action?: string }
      | null;

    const result: GenerationCancelResult = {
      promptId: body?.prompt_id ?? promptId,
      cancelled: body?.cancelled !== false,
      action: body?.action ?? null,
    };
    res.json(result);
  } catch (err) {
    const failure = transportFailure(err);
    console.error('Cancel transport error:', failure.error, err);
    res.status(failure.status).json({ error: failure.error });
  }
});

export default router;
