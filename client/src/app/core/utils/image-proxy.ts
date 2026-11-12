/** Stored images (blob URLs) are served through the app's image proxy: the URL for an <img>, or null when there's no image. */
export function proxyImageUrl(blobUrl: string | undefined): string | null {
  const filename = blobUrl?.split('/').pop();
  return filename ? `/api/image/${filename}` : null;
}
