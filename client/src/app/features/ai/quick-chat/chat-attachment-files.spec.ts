import { dragHasFiles, partitionImageFiles } from './chat-attachment-files';

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('dragHasFiles', () => {
  it('is true only when the drag carries files', () => {
    expect(dragHasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
    expect(dragHasFiles({ types: ['text/plain', 'text/html'] } as unknown as DataTransfer)).toBe(false);
    expect(dragHasFiles(null)).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});

describe('partitionImageFiles', () => {
  it('keeps raster images and counts everything else as skipped', () => {
    const png = file('a.png', 'image/png');
    const jpg = file('b.jpg', 'image/jpeg');
    const { images, skipped } = partitionImageFiles([
      png, file('notes.pdf', 'application/pdf'), jpg, file('logo.svg', 'image/svg+xml'), file('x', ''),
    ]);
    expect(images).toEqual([png, jpg]);
    expect(skipped).toBe(3);
  });

  it('handles an empty drop', () => {
    expect(partitionImageFiles([])).toEqual({ images: [], skipped: 0 });
  });
});
