import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { Series } from '@shared/models/series.model';
import { Book } from '@shared/models/book.model';
import { Chapter } from '@shared/models/chapter.model';
import { ExplorerService } from './explorer.service';
import { SeriesService } from '../series/series.service';
import { BookService } from '../book/book.service';
import { ChapterService } from '../chapter/chapter.service';

const series: Series[] = [
  { id: 's-dune', title: 'Dune Saga' },
  { id: 's-culture', title: 'The Culture' },
  { id: 's-archived', title: 'Old Series', archived: true },
];

const books: Book[] = [
  { id: 'b-messiah', title: 'Messiah', seriesId: 's-dune', sortOrder: 2 },
  { id: 'b-dune', title: 'Dune', seriesId: 's-dune', sortOrder: 1 },
  { id: 'b-player', title: 'Player of Games', seriesId: 's-culture' },
  { id: 'b-deleted', title: 'Deleted Book', seriesId: 's-dune', deleted: true },
];

const chapters: Chapter[] = [
  { id: 'c-spice', title: 'The Spice', bookId: 'b-dune', sortOrder: 1 },
  { id: 'c-storm', title: 'A Storm Coming', bookId: 'b-dune', sortOrder: 2 },
  { id: 'c-gurgeh', title: 'Gurgeh', bookId: 'b-player' },
  { id: 'c-archived', title: 'Archived Chapter', bookId: 'b-dune', archived: true },
];

describe('ExplorerService', () => {
  let service: ExplorerService;
  let seriesStub: { getAll: ReturnType<typeof vi.fn> };
  let bookStub: { getAll: ReturnType<typeof vi.fn>; getBySeries: ReturnType<typeof vi.fn> };
  let chapterStub: { getAll: ReturnType<typeof vi.fn>; getByBook: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    seriesStub = { getAll: vi.fn(() => of(series)) };
    bookStub = { getAll: vi.fn(() => of(books)), getBySeries: vi.fn(() => of([])) };
    chapterStub = { getAll: vi.fn(() => of(chapters)), getByBook: vi.fn(() => of([])) };

    TestBed.configureTestingModule({
      providers: [
        { provide: SeriesService, useValue: seriesStub },
        { provide: BookService, useValue: bookStub },
        { provide: ChapterService, useValue: chapterStub },
      ],
    });
    service = TestBed.inject(ExplorerService);
  });

  describe('open / tree loading', () => {
    it('loads the whole tree on first open, hiding archived/deleted nodes', () => {
      service.open();
      expect(service.isOpen()).toBe(true);
      expect(service.series().map(s => s.id)).toEqual(['s-dune', 's-culture']);
      expect(service.booksFor('s-dune').map(b => b.id)).toEqual(['b-dune', 'b-messiah']); // sorted
      expect(service.chaptersFor('b-dune').map(c => c.id)).toEqual(['c-spice', 'c-storm']);
    });

    it('reuses the cache on subsequent opens', () => {
      service.open();
      service.close();
      service.open();
      expect(seriesStub.getAll).toHaveBeenCalledTimes(1);
    });

    it('clears the loading flag when the bulk load fails', () => {
      seriesStub.getAll.mockReturnValue(throwError(() => new Error('offline')));
      service.open();
      expect(service.seriesLoading()).toBe(false);
      expect(service.series()).toEqual([]);
    });

    it('skips the per-node fetch when the eager load pre-seeded the cache', () => {
      service.open();
      service.toggleSeries('s-dune');
      service.toggleBook('b-dune');
      expect(bookStub.getBySeries).not.toHaveBeenCalled();
      expect(chapterStub.getByBook).not.toHaveBeenCalled();
    });
  });

  describe('filtering', () => {
    beforeEach(() => service.open());

    it('shows all series when the filter is empty', () => {
      expect(service.filteredSeries()).toHaveLength(2);
    });

    it('matches series by title, case-insensitively', () => {
      service.setFilter('CULTURE');
      expect(service.filteredSeries().map(s => s.id)).toEqual(['s-culture']);
    });

    it('surfaces a series when a descendant chapter matches', () => {
      service.setFilter('spice');
      expect(service.filteredSeries().map(s => s.id)).toEqual(['s-dune']);
    });

    it('a matching series title reveals all of its books', () => {
      service.setFilter('dune saga');
      expect(service.filteredBooksFor('s-dune').map(b => b.id)).toEqual(['b-dune', 'b-messiah']);
    });

    it('narrows books to those matching or containing a match', () => {
      service.setFilter('storm');
      expect(service.filteredBooksFor('s-dune').map(b => b.id)).toEqual(['b-dune']);
      expect(service.filteredBooksFor('s-culture')).toEqual([]);
    });

    it('a matching ancestor reveals all chapters of a book', () => {
      service.setFilter('messiah');
      // Book b-messiah matches, so its (empty) chapter list is untouched;
      // b-dune has no match, so its chapters are narrowed away.
      expect(service.filteredChaptersFor('b-dune')).toEqual([]);
      service.setFilter('dune');
      expect(service.filteredChaptersFor('b-dune').map(c => c.id)).toEqual(['c-spice', 'c-storm']);
    });

    it('narrows chapters by title when no ancestor matches', () => {
      service.setFilter('storm');
      expect(service.filteredChaptersFor('b-dune').map(c => c.id)).toEqual(['c-storm']);
    });

    it('auto-expands series and books that contain a match', () => {
      service.setFilter('gurgeh');
      expect(service.isSeriesExpanded('s-culture')).toBe(true);
      expect(service.isBookExpanded('b-player')).toBe(true);
      expect(service.isSeriesExpanded('s-dune')).toBe(false);
    });

    it('clearFilter restores the unfiltered view', () => {
      service.setFilter('gurgeh');
      service.clearFilter();
      expect(service.filteredSeries()).toHaveLength(2);
      expect(service.isSeriesExpanded('s-culture')).toBe(false);
    });
  });

  describe('expansion state', () => {
    it('toggleSeries expands and collapses', () => {
      service.open();
      service.toggleSeries('s-dune');
      expect(service.isSeriesExpanded('s-dune')).toBe(true);
      service.toggleSeries('s-dune');
      expect(service.isSeriesExpanded('s-dune')).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all state so the next open reloads', () => {
      service.open();
      service.setFilter('dune');
      service.toggleSeries('s-dune');
      service.reset();

      expect(service.isOpen()).toBe(false);
      expect(service.series()).toEqual([]);
      expect(service.filter()).toBe('');
      expect(service.expandedSeries().size).toBe(0);

      service.open();
      expect(seriesStub.getAll).toHaveBeenCalledTimes(2);
    });
  });
});
