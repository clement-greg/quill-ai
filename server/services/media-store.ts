import path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { uploadFileToBlob } from './storage';
import { VIDEO_EXTENSIONS } from '../../shared/models/entity.model';

/** Max width or height in px for the thumbnail generated alongside an image. */
export const DEFAULT_THUMBNAIL_SIZE = 400;

/** Raster formats every browser can display — stored byte-for-byte as given. */
export const WEB_SAFE_RASTER_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'];

/**
 * Raster formats accepted but re-encoded to JPEG on the way in. HEIC is what an
 * iPhone hands over for a library photo, and only Safari can render it — storing
 * it as-is would upload fine and then show a broken image everywhere else.
 */
export const TRANSCODE_RASTER_EXTS = ['.heic', '.heif', '.jfif', '.bmp', '.tif', '.tiff'];
export const RASTER_EXTS = [...WEB_SAFE_RASTER_EXTS, ...TRANSCODE_RASTER_EXTS];
export const SVG_EXTS = ['.svg'];
export const VIDEO_EXTS = VIDEO_EXTENSIONS;

export const VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
};

/**
 * Fallback extension when a file arrives without a usable one — iOS share
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

export const KNOWN_EXTS = [...RASTER_EXTS, ...SVG_EXTS, ...VIDEO_EXTS];

/** The extension to store a file under, falling back to its MIME type. */
export function resolveExt(originalname: string, mimetype: string): string {
  const ext = path.extname(originalname).toLowerCase();
  if (KNOWN_EXTS.includes(ext)) return ext;
  return EXT_BY_MIME[mimetype.toLowerCase()] ?? ext;
}

export interface StoredMedia {
  url: string;
  thumbnailUrl: string;
}

/**
 * Stores one image or video as a gallery asset: the original plus a thumbnail,
 * both encrypted at rest. Shared by the upload endpoint and the generation
 * collector so a generated asset is indistinguishable from an uploaded one —
 * same `<uuid><ext>` naming, same `<uuid>_thumb.webp` companion the image proxy
 * and the gallery expect.
 */
export async function storeMedia(
  buffer: Buffer,
  opts: { ext: string; mimeType: string; thumbSize?: number }
): Promise<StoredMedia> {
  const ext = opts.ext.toLowerCase();
  const id = uuidv4();
  const thumbSize = opts.thumbSize ?? DEFAULT_THUMBNAIL_SIZE;
  const mimeType = ext === '.svg' ? 'image/svg+xml' : opts.mimeType;

  if (VIDEO_EXTS.includes(ext) || opts.mimeType.toLowerCase().startsWith('video/')) {
    // Videos can't be thumbnailed with sharp — store once and reuse the URL for
    // both. The gallery seeks to the first frame instead (see videoPosterUrl).
    const videoMime = VIDEO_MIME_BY_EXT[ext] ?? opts.mimeType;
    const url = await uploadFileToBlob(buffer, `${id}${ext}`, videoMime);
    return { url, thumbnailUrl: url };
  }

  if (SVG_EXTS.includes(ext)) {
    // SVGs are already scalable — one blob serves as both.
    const url = await uploadFileToBlob(buffer, `${id}${ext}`, mimeType);
    return { url, thumbnailUrl: url };
  }

  // `.rotate()` bakes in the EXIF orientation phone cameras rely on; without
  // it, portrait shots come back on their side once the metadata is dropped.
  const transcode = TRANSCODE_RASTER_EXTS.includes(ext);
  const thumbnailBuffer = await sharp(buffer)
    .rotate()
    .resize(thumbSize, thumbSize, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  const originalBuffer = transcode
    ? await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer()
    : buffer;

  const [url, thumbnailUrl] = await Promise.all([
    uploadFileToBlob(originalBuffer, transcode ? `${id}.jpg` : `${id}${ext}`, transcode ? 'image/jpeg' : mimeType),
    uploadFileToBlob(thumbnailBuffer, `${id}_thumb.webp`, 'image/webp'),
  ]);
  return { url, thumbnailUrl };
}
