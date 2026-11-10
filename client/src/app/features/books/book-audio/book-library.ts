import { Book } from '@shared/models/book.model';
import { Series } from '@shared/models/series.model';
import { proxyImageUrl } from './book-audio.service';

/** A book offered in the player's book picker. */
export interface LibraryBook {
  id: string;
  title: string;
  /** Proxied cover thumbnail, ready for an <img>. */
  coverUrl: string | null;
}

/** A series and its books, in reading order. */
export interface LibrarySeries {
  id: string;
  title: string;
  books: LibraryBook[];
}

/**
 * Groups books under their series for the book picker: live series and books
 * only, books in reading order, series with no books left out. The series
 * being listened to comes first, then the rest by title.
 */
export function buildLibrary(
  series: readonly Series[],
  booksBySeries: ReadonlyMap<string, readonly Book[]>,
  currentSeriesId?: string | null,
): LibrarySeries[] {
  return series
    .filter(s => !s.archived && !s.deleted)
    .map(s => ({
      id: s.id,
      title: s.title.trim() || 'Untitled series',
      books: (booksBySeries.get(s.id) ?? [])
        .filter(b => !b.archived && !b.deleted)
        .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
        .map(b => ({
          id: b.id,
          title: b.title.trim() || 'Untitled book',
          coverUrl: proxyImageUrl(b.thumnailUrl ?? b.originalUrl),
        })),
    }))
    .filter(s => s.books.length > 0)
    .sort((a, b) =>
      Number(b.id === currentSeriesId) - Number(a.id === currentSeriesId) ||
      a.title.localeCompare(b.title));
}
