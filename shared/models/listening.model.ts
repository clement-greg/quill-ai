/** Where the reader stopped listening to a book (one per book, per user). */
export interface ListeningPosition {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  /** Paragraph within the chapter; -1 for the chapter title. */
  blockIndex: number;
  /** How far through the whole book, 0–1. */
  progress: number;
  /** Cover image (blob URL as stored on the book). */
  coverUrl?: string;
  /** Listened through to the end: the next play starts from the beginning. */
  finished?: boolean;
  /** Stamped by the server. */
  updatedAt: number;
}

/** Fields a client sends when saving a position. */
export type ListeningPositionUpdate = Omit<ListeningPosition, 'bookId' | 'updatedAt'>;
