import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { uploadFileToBlob } from '../services/storage';

const router = Router();
const DEFAULT_THUMBNAIL_SIZE = 400; // max width or height in px for palette stamps

const RASTER_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const SVG_EXTS = ['.svg'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];

const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB (videos are larger than images)
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([...RASTER_EXTS, ...SVG_EXTS, ...VIDEO_EXTS].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  },
});

// POST /api/upload  — multipart/form-data with field name "file"
// Optional query param: ?thumbSize=N overrides the default 400px max dimension (e.g. 1600 for map previews)
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const thumbSize = Math.min(
      Math.max(parseInt(String(req.query['thumbSize'] ?? ''), 10) || DEFAULT_THUMBNAIL_SIZE, 100),
      4096
    );

    const ext = path.extname(req.file.originalname).toLowerCase();
    const id = uuidv4();
    const originalFilename = `${id}${ext}`;
    const mimeType = ext === '.svg' ? 'image/svg+xml' : req.file.mimetype;

    let originalUrl: string;
    let thumbnailUrl: string;

    if (VIDEO_EXTS.includes(ext)) {
      // Videos can't be thumbnailed with sharp — upload once and reuse the URL for both.
      const videoMime = VIDEO_MIME_BY_EXT[ext] ?? req.file.mimetype;
      originalUrl = await uploadFileToBlob(req.file.buffer, originalFilename, videoMime);
      thumbnailUrl = originalUrl;
    } else if (SVG_EXTS.includes(ext)) {
      // SVGs are already scalable — upload once and use for both url and thumbnailUrl.
      originalUrl = await uploadFileToBlob(req.file.buffer, originalFilename, mimeType);
      thumbnailUrl = originalUrl;
    } else {
      const thumbnailFilename = `${id}_thumb.webp`;
      const thumbnailBuffer = await sharp(req.file.buffer)
        .resize(thumbSize, thumbSize, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
      [originalUrl, thumbnailUrl] = await Promise.all([
        uploadFileToBlob(req.file.buffer, originalFilename, mimeType),
        uploadFileToBlob(thumbnailBuffer, thumbnailFilename, 'image/webp'),
      ]);
    }

    res.json({ url: originalUrl, thumbnailUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

export default router;
