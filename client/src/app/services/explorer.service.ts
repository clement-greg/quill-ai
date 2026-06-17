import { Injectable, computed, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
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
 * expanded-node sets and the eagerly-loaded tree caches all survive the panel
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

  // Free-text filter applied to the Library tree (matches by title)
  readonly filter = signal('');

  // Reverse lookup: bookId -> seriesId, derived from loaded book caches
  private readonly bookSeries = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const [seriesId, books] of Object.entries(this.booksBySeries())) {
      for (const b of books) map[b.id] = seriesId;
    }
    return map;
  });

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

  /**
   * Eagerly loads the entire Series → Book → Chapter tree in three parallel
   * bulk requests on first open, grouping books/chapters into the caches by
   * parent id. Loading everything up front is what lets the filter reach nodes
   * that haven't been manually expanded. Subsequent opens reuse the caches.
   */
  private loadSeries(): void {
    if (this.seriesLoaded || this.seriesLoading()) return;
    this.seriesLoading.set(true);
    forkJoin({
      series: this.seriesService.getAll(),
      books: this.bookService.getAll(),
      chapters: this.chapterService.getAll(),
    }).subscribe({
      next: ({ series, books, chapters }) => {
        const visibleSeries = series.filter(s => !s.archived && !s.deleted);
        this.series.set(visibleSeries);

        // Group visible books under their series, pre-seeding an (empty) bucket
        // for every series so the per-node load guards short-circuit.
        const booksBySeries: Record<string, Book[]> = {};
        for (const s of visibleSeries) booksBySeries[s.id] = [];
        for (const b of books) {
          if (b.archived || b.deleted) continue;
          booksBySeries[b.seriesId]?.push(b);
        }
        for (const list of Object.values(booksBySeries)) {
          list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        }
        this.booksBySeries.set(booksBySeries);

        // Group visible chapters under their book, pre-seeding a bucket per book.
        const chaptersByBook: Record<string, Chapter[]> = {};
        for (const list of Object.values(booksBySeries)) {
          for (const b of list) chaptersByBook[b.id] = [];
        }
        for (const c of chapters) {
          if (c.archived) continue;
          chaptersByBook[c.bookId]?.push(c);
        }
        for (const list of Object.values(chaptersByBook)) {
          list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        }
        this.chaptersByBook.set(chaptersByBook);

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

  setFilter(value: string): void {
    this.filter.set(value);
  }

  clearFilter(): void {
    this.filter.set('');
  }

  private query(): string {
    return this.filter().trim().toLowerCase();
  }

  private matchesText(text: string | undefined, q: string): boolean {
    return !!text && text.toLowerCase().includes(q);
  }

  /**
   * Whether a series has any *loaded* descendant matching the query. Lazy
   * loading means only expanded branches can be searched into; series titles
   * themselves are always searchable since the top-level list is fully loaded.
   */
  private seriesHasMatch(seriesId: string, q: string): boolean {
    return (this.booksBySeries()[seriesId] ?? []).some(
      b => this.matchesText(b.title, q) || this.bookHasMatch(b.id, q),
    );
  }

  private bookHasMatch(bookId: string, q: string): boolean {
    return (this.chaptersByBook()[bookId] ?? []).some(c => this.matchesText(c.title, q));
  }

  /** True when the book or its parent series title matches the query. */
  private ancestorMatches(bookId: string, q: string): boolean {
    const seriesId = this.bookSeries()[bookId];
    const books = seriesId ? (this.booksBySeries()[seriesId] ?? []) : [];
    const series = seriesId ? this.series().find(s => s.id === seriesId) : undefined;
    const book = books.find(b => b.id === bookId);
    return this.matchesText(series?.title, q) || this.matchesText(book?.title, q);
  }

  /** Series to display, narrowed by the active filter (no filter → all). */
  filteredSeries(): Series[] {
    const q = this.query();
    if (!q) return this.series();
    return this.series().filter(
      s => this.matchesText(s.title, q) || this.seriesHasMatch(s.id, q),
    );
  }

  /** Books to display under a series, narrowed by the active filter. */
  filteredBooksFor(seriesId: string): Book[] {
    const q = this.query();
    const books = this.booksFor(seriesId);
    if (!q) return books;
    // A matching series reveals all of its (loaded) books.
    const series = this.series().find(s => s.id === seriesId);
    if (this.matchesText(series?.title, q)) return books;
    return books.filter(b => this.matchesText(b.title, q) || this.bookHasMatch(b.id, q));
  }

  /** Chapters to display under a book, narrowed by the active filter. */
  filteredChaptersFor(bookId: string): Chapter[] {
    const q = this.query();
    const chapters = this.chaptersFor(bookId);
    if (!q) return chapters;
    // A matching book/series reveals all of its (loaded) chapters.
    if (this.ancestorMatches(bookId, q)) return chapters;
    return chapters.filter(c => this.matchesText(c.title, q));
  }

  /** Series shows as expanded when toggled open, or auto-opened by a filter match. */
  isSeriesExpanded(seriesId: string): boolean {
    if (this.expandedSeries().has(seriesId)) return true;
    const q = this.query();
    return !!q && this.seriesHasMatch(seriesId, q);
  }

  /** Book shows as expanded when toggled open, or auto-opened by a filter match. */
  isBookExpanded(bookId: string): boolean {
    if (this.expandedBooks().has(bookId)) return true;
    const q = this.query();
    return !!q && this.bookHasMatch(bookId, q);
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
    this.filter.set('');
  }
}
