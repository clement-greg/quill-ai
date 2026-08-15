/**
 * Files the entity photo gallery accepts. Stills and video share the same
 * `photos` array and the same upload endpoint; the server rejects anything else.
 */
export function isGalleryMediaFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}

/** The gallery media files from a drag-and-drop payload, ignoring the rest. */
export function galleryMediaFrom(dataTransfer: DataTransfer | null | undefined): File[] {
  return Array.from(dataTransfer?.files ?? []).filter(isGalleryMediaFile);
}
