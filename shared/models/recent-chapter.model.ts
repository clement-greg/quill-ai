/** A single chapter-visit record. Append-only: one row is inserted per visit. */
export interface ChapterVisit {
  id: string;
  userSub: string;
  chapterId: string;
  chapterTitle: string;
  bookTitle: string;
  seriesTitle: string;
  thumbnailUrl?: string;
  visitedAt: number;
}

/** Shape returned to the client for the "Continue writing" list (one per chapter). */
export interface RecentChapter {
  chapterId: string;
  chapterTitle: string;
  bookTitle: string;
  seriesTitle: string;
  thumbnailUrl?: string;
  visitedAt: number;
}
