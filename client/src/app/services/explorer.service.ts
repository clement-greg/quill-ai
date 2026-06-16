import { Injectable, inject, signal } from '@angular/core';
import { Series } from '@shared/models/series.model';
import { Book } from '@shared/models/book.model';
import { Chapter } from '@shared/models/chapter.model';
import { SeriesService } from '../series/series.service';
import { BookService } from '../book/book.service';
import { ChapterService } from '../chapter/chapter.service';

/**
 * Backing state for the Application Explorer drawer.
 *
 * `providedIn: 'root'` makes this a singleton, so the open/closed flag, the
 * expanded-node sets and the lazily-loaded child caches all survive the panel
 * being closed and reopened within a session. A full app reload recreates the
 * service, which resets everything — by design we deliberately avoid
 * localStorage so state is *not* remembered across app restarts.
 */
@Injectable({ providedIn: 'root' })
export class ExplorerService {
  private readonly seriesService = inject(SeriesService);
  private readonly bookService = inject(BookService);
  private readonly chapterService = inject(ChapterService);

  // Panel open/closed state
  readonly isOpen = signal(false);

  // Top-level series list (loaded once on first open)
  readonly series = signal<Series[]>([]);
  readonly seriesLoading = signal(false);
  private seriesLoaded = false;

  // Expanded node ids
  readonly expandedSeries = signal<Set<string>>(new Set());
  readonly expandedBooks = signal<Set<string>>(new Set());

  // Lazy-loaded child caches keyed by parent id
  readonly booksBySeries = signal<Record<string, Book[]>>({});
  readonly chaptersByBook = signal<Record<string, Chapter[]>>({});

  // Ids of parents whose children are currently being fetched
  readonly loadingChildren = signal<Set<string>>(new Set());

  open(): void {
    this.isOpen.set(true);
    this.loadSeries();
  }

  close(): void {
    this.isOpen.set(false);
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  /** Loads the series list once; subsequent opens reuse the cached list. */
  private loadSeries(): void {
    if (this.seriesLoaded || this.seriesLoading()) return;
    this.seriesLoading.set(true);
    this.seriesService.getAll().subscribe({
      next: list => {
        this.series.set(list.filter(s => !s.archived && !s.deleted));
        this.seriesLoaded = true;
        this.seriesLoading.set(false);
      },
      error: () => this.seriesLoading.set(false),
    });
  }

  toggleSeries(seriesId: string): void {
    const expanded = new Set(this.expandedSeries());
    if (expanded.has(seriesId)) {
      expanded.delete(seriesId);
    } else {
      expanded.add(seriesId);
      this.loadBooks(seriesId);
    }
    this.expandedSeries.set(expanded);
  }

  toggleBook(bookId: string): void {
    const expanded = new Set(this.expandedBooks());
    if (expanded.has(bookId)) {
      expanded.delete(bookId);
    } else {
      expanded.add(bookId);
      this.loadChapters(bookId);
    }
    this.expandedBooks.set(expanded);
  }

  private loadBooks(seriesId: string): void {
    if (this.booksBySeries()[seriesId] || this.loadingChildren().has(seriesId)) return;
    this.setLoading(seriesId, true);
    this.bookService.getBySeries(seriesId).subscribe({
      next: books => {
        const sorted = [...books]
          .filter(b => !b.archived && !b.deleted)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        this.booksBySeries.update(map => ({ ...map, [seriesId]: sorted }));
        this.setLoading(seriesId, false);
      },
      error: () => this.setLoading(seriesId, false),
    });
  }

  private loadChapters(bookId: string): void {
    if (this.chaptersByBook()[bookId] || this.loadingChildren().has(bookId)) return;
    this.setLoading(bookId, true);
    this.chapterService.getByBook(bookId).subscribe({
      next: chapters => {
        const sorted = [...chapters]
          .filter(c => !c.archived)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        this.chaptersByBook.update(map => ({ ...map, [bookId]: sorted }));
        this.setLoading(bookId, false);
      },
      error: () => this.setLoading(bookId, false),
    });
  }

  private setLoading(id: string, loading: boolean): void {
    const next = new Set(this.loadingChildren());
    if (loading) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.loadingChildren.set(next);
  }

  /** Cached books for a series (empty until its node is expanded/loaded). */
  booksFor(seriesId: string): Book[] {
    return this.booksBySeries()[seriesId] ?? [];
  }

  /** Cached chapters for a book (empty until its node is expanded/loaded). */
  chaptersFor(bookId: string): Chapter[] {
    return this.chaptersByBook()[bookId] ?? [];
  }

  /** Clears everything, e.g. on sign-out, so a different account starts clean. */
  reset(): void {
    this.isOpen.set(false);
    this.series.set([]);
    this.seriesLoaded = false;
    this.seriesLoading.set(false);
    this.expandedSeries.set(new Set());
    this.expandedBooks.set(new Set());
    this.booksBySeries.set({});
    this.chaptersByBook.set({});
    this.loadingChildren.set(new Set());
  }
}
