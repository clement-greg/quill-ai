import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { uploadFileToBlob, downloadBlob } from '../services/storage';
import { VIDEO_EXTENSIONS, isVideoUrl } from '../../shared/models/entity.model';

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

/**
 * Where "Upload" on a gallery photo sends it. The receiver takes the raw image
 * bytes as the POST body and names the file from `?name=`.
 */
const PHOTO_EXPORT_URL = (
  process.env['PHOTO_EXPORT_URL'] || 'https://gzm6dftk-8787.usw3.devtunnels.ms/'
).replace(/\/+$/, '');

/**
 * POST /api/upload/photo-export  { url }  →  { name }
 *
 * Relays one stored photo to the external receiver. This goes through the
 * server rather than the browser because stored blobs are encrypted at rest:
 * downloadBlob() is what decrypts them, and the receiver sends no CORS headers,
 * so a fetch straight from the page could neither read the bytes nor the reply.
 */
router.post('/photo-export', async (req: Request, res: Response) => {
  const url = typeof req.body?.url === 'string' ? req.body.url : '';
  const filename = url.split('/').pop() ?? '';

  // Stored blobs are named `<uuid><ext>`, so anything with a path separator in
  // it did not come from us.
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
    res.status(400).json({ error: 'Invalid photo url' });
    return;
  }
  if (isVideoUrl(filename)) {
    res.status(400).json({ error: 'Only photos can be uploaded' });
    return;
  }

  try {
    const { data, contentType } = await downloadBlob(filename);
    const target = `${PHOTO_EXPORT_URL}/upload?name=${encodeURIComponent(filename)}`;
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
      // look like a successful upload, so treat any redirect as a failure.
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      console.error('Photo export redirected to', response.headers.get('location'));
      res.status(502).json({ error: 'Receiver requires sign-in — make the tunnel public' });
      return;
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      console.error('Photo export failed:', response.status, detail);
      res.status(502).json({ error: `Receiver returned ${response.status}` });
      return;
    }

    res.json({ name: filename });
  } catch (err: any) {
    if (err?.statusCode === 404) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }
    console.error('Photo export error:', err);
    res.status(502).json({ error: 'Could not reach the upload receiver' });
  }
});

export default router;
