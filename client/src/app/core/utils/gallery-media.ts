/** Extensions we accept when a file arrives with no MIME type of its own. */
const MEDIA_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg',
  '.heic', '.heif', '.jfif', '.bmp', '.tif', '.tiff',
  '.mp4', '.m4v', '.mov', '.webm', '.ogv',
];

/**
 * Files the entity photo gallery accepts. Stills and video share the same
 * `photos` array and the same upload endpoint; the server rejects anything else.
 *
 * The MIME type is the primary test, but iOS can hand over a library photo with
 * `type` empty — filtering on type alone silently discards the user's pick and
 * the upload appears to do nothing at all.
 */
export function isGalleryMediaFile(file: File): boolean {
  if (file.type.startsWith('image/') || file.type.startsWith('video/')) return true;
  if (file.type) return false;
  const name = file.name.toLowerCase();
  return MEDIA_EXTENSIONS.some(ext => name.endsWith(ext));
}

/** The gallery media files from a drag-and-drop payload, ignoring the rest. */
export function galleryMediaFrom(dataTransfer: DataTransfer | null | undefined): File[] {
  return Array.from(dataTransfer?.files ?? []).filter(isGalleryMediaFile);
}
