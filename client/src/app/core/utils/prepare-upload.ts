/** Longest edge, in px, a photo is reduced to before upload. */
const MAX_EDGE = 2560;
const JPEG_QUALITY = 0.9;

/**
 * Formats left exactly as picked: vector art has no pixels to resize, and
 * re-encoding a GIF through a canvas would flatten it to its first frame.
 */
const PASS_THROUGH = ['image/svg+xml', 'image/gif'];

/**
 * Shrinks a picked photo to a modest JPEG before it goes over the wire.
 *
 * A 12-megapixel iPhone photo is several MB, and a long upload from a phone is
 * what gets cut short in transit ("unexpected end of form" on the server) —
 * a few hundred KB goes up in one breath. Decoding here also forces an
 * iCloud-backed photo to materialise on the device first, so a photo that
 * cannot be read fails locally with a message instead of half-sending.
 *
 * Anything this cannot handle — video, vector art, a format the browser will
 * not decode — is returned untouched for the server to deal with, so a failure
 * here can never cost the user their upload.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  if (!isResizableImage(file)) return file;

  try {
    // `from-image` applies the EXIF orientation an iPhone records rather than
    // baking the sideways sensor pixels straight into the canvas.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    );
    if (!blob) return file;
    // An already-small JPEG can come back bigger than it went in; keep the original.
    if (blob.size >= file.size && file.type === 'image/jpeg') return file;

    return new File([blob], toJpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    // Chrome cannot decode HEIC, for one — the server handles those itself.
    return file;
  }
}

function isResizableImage(file: File): boolean {
  if (PASS_THROUGH.includes(file.type)) return false;
  if (file.type.startsWith('video/')) return false;
  // An empty type is the iOS library-photo case: trust the extension instead.
  if (file.type.startsWith('image/')) return true;
  return !file.type && /\.(jpe?g|png|webp|avif|heic|heif|jfif|bmp|tiff?)$/i.test(file.name);
}

function toJpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'photo'}.jpg`;
}
