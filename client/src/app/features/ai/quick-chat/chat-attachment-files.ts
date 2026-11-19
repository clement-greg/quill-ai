/** Whether a drag carries files from outside the page (not dragged text or links). */
export function dragHasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes('Files');
}

/** Splits dropped or pasted files into the images to attach and a count of the rest. */
export function partitionImageFiles(files: Iterable<File>): { images: File[]; skipped: number } {
  const images: File[] = [];
  let skipped = 0;
  for (const file of files) {
    if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') images.push(file);
    else skipped++;
  }
  return { images, skipped };
}
