/** A chapter as listed for navigation: just enough to link and label it. */
export interface ChapterNavItem {
  id: string;
  title: string;
}

/** The chapters either side of `currentId` in a book's reading order.
 *  Either side is null at the ends of the book, or when the current chapter
 *  isn't in the list at all. */
export function adjacentChapters(
  chapters: readonly ChapterNavItem[],
  currentId: string | null | undefined,
): { prev: ChapterNavItem | null; next: ChapterNavItem | null } {
  const index = currentId ? chapters.findIndex(c => c.id === currentId) : -1;
  if (index < 0) return { prev: null, next: null };
  return {
    prev: chapters[index - 1] ?? null,
    next: chapters[index + 1] ?? null,
  };
}
