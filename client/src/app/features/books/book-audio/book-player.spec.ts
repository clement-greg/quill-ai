import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MatDialog } from '@angular/material/dialog';
import { SPEECH_ENGINE, ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { SpeechEngine, SpeechEngineListener } from '@app/core/read-aloud/read-aloud.model';
import { BookPlayerComponent } from './book-player';
import { BookAudioService } from './book-audio.service';
import { ChapterDraftService } from '@app/features/chapters/chapter-edit/chapter-draft.service';

/** n words; at 170 words a minute, 170 words take 60s to say. */
const words = (first: string, n: number) => [first, ...Array(n - 1).fill('word')].join(' ');

// Estimated segment times at 1× (each paragraph adds a 0.25s pause, titles 0.6s):
// Arrival 0.95s · one 60.25s · four 30.25s · six 60.25s | Begin 0.95s · seven 0.6s
const BOOK = [
  { id: 'a', title: 'Arrival', html: `<p>${words('one', 170)}</p><p>${words('four', 85)}</p><p>${words('six', 170)}</p>` },
  { id: 'b', title: 'Begin', html: '<p>seven eight</p>' },
];

function fakeEngine() {
  let listener!: SpeechEngineListener;
  const engine = {
    kind: 'web' as const,
    setListener: vi.fn((l: SpeechEngineListener) => { listener = l; }),
    getVoices: vi.fn().mockResolvedValue([]),
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  } satisfies SpeechEngine;
  return { engine, emit: () => listener };
}

describe('BookPlayerComponent', () => {
  function setup() {
    const { engine, emit } = fakeEngine();
    TestBed.configureTestingModule({
      imports: [BookPlayerComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SPEECH_ENGINE, useValue: engine },
        { provide: MatDialog, useValue: { open: vi.fn() } },
        { provide: ChapterDraftService, useValue: {} },
      ],
    });
    localStorage.clear();
    const ra = TestBed.inject(ReadAloudService);
    ra.start(BOOK, { bookTitle: 'Book', bookId: 'b1' });
    TestBed.inject(BookAudioService).nowPlaying.set({ bookId: 'b1', seriesId: 's1', title: 'Book', coverUrl: '/api/image/cover.png', chapterArt: { b: '/api/image/b.png' } });
    const fixture = TestBed.createComponent(BookPlayerComponent);
    fixture.detectChanges();
    return { fixture, cmp: fixture.componentInstance, ra, engine, emit, el: fixture.nativeElement as HTMLElement };
  }

  it('shows the book, the current chapter and where it is in the book', () => {
    const { el, cmp } = setup();
    expect(el.querySelector('.bp-head-title')?.textContent).toContain('Book');
    expect(el.querySelector('.bp-chapter-heading')?.textContent).toContain('Arrival');
    expect(el.querySelector('.bp-sub')?.textContent).toContain('Chapter 1 of 2');
    expect(cmp.bookProgress()?.percent).toBe(0);
    expect(cmp.clock().elapsed).toBe('0:00');
  });

  it('shows the chapter picture when it has one, else the book cover', () => {
    const { el, emit, fixture } = setup();
    const art = () => el.querySelector<HTMLImageElement>('.bp-art img')?.getAttribute('src');
    expect(art()).toBe('/api/image/cover.png');
    emit().progress(4);
    fixture.detectChanges();
    expect(art()).toBe('/api/image/b.png');
  });

  it('shows a placeholder when there is no picture at all', () => {
    const { el, fixture } = setup();
    TestBed.inject(BookAudioService).nowPlaying.set({ bookId: 'b1', seriesId: 's1', title: 'Book', coverUrl: null, chapterArt: {} });
    fixture.detectChanges();
    expect(el.querySelector('.bp-art img')).toBeNull();
    expect(el.querySelector('.bp-art mat-icon')?.textContent).toContain('auto_stories');
  });

  it('scrubs through the chapter by time, previewing the paragraph before seeking', () => {
    const { cmp, ra, fixture, el } = setup();
    expect(cmp.scrubMax()).toBe(152); // the chapter's estimated length in seconds
    expect(cmp.clock().remaining).toBe('2:32');
    cmp.onScrub(70);
    fixture.detectChanges();
    expect(cmp.clock().elapsed).toBe('1:10');
    expect(el.querySelector('.bp-preview')?.textContent).toMatch(/^four word/);
    expect(ra.index()).toBe(0);
    cmp.commitScrub(70);
    // Speech starts at a paragraph, so it lands at the start of "four".
    expect(ra.index()).toBe(2);
    expect(cmp.scrubbing()).toBeNull();
    expect(cmp.scrubValue()).toBe(61);
    expect(cmp.formatThumb(61)).toBe('1:01 of 2:32');
  });

  it('scales the scrubber and clock with the speed', () => {
    const { cmp, ra } = setup();
    ra.setRate(2);
    expect(cmp.scrubMax()).toBe(76);
    cmp.commitScrub(35); // 70s of 1× speech
    expect(ra.index()).toBe(2);
  });

  describe('while playing', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('moves the play head through a paragraph, pausing with playback', () => {
      const { cmp, emit, ra } = setup();
      emit().progress(1); // "one", which starts 0.95s in
      emit().state('playing');
      TestBed.tick();
      expect(cmp.clock().elapsed).toBe('0:01');
      vi.advanceTimersByTime(10_000);
      TestBed.tick();
      expect(cmp.clock().elapsed).toBe('0:11');
      expect(cmp.scrubValue()).toBe(11);

      emit().state('paused');
      TestBed.tick();
      vi.advanceTimersByTime(5_000);
      expect(cmp.clock().elapsed).toBe('0:11');

      emit().state('playing');
      TestBed.tick();
      vi.advanceTimersByTime(5_000);
      expect(cmp.clock().elapsed).toBe('0:16');

      // Never runs past the paragraph's estimate while it's still being read.
      vi.advanceTimersByTime(120_000);
      expect(cmp.clock().elapsed).toBe('1:01');
      expect(cmp.bookProgress()?.percent).toBe(40);

      // The next paragraph starts the count again from its own start.
      emit().progress(2);
      TestBed.tick();
      expect(cmp.clock().elapsed).toBe('1:01');
      vi.advanceTimersByTime(3_000);
      expect(cmp.clock().elapsed).toBe('1:04');

      // A speed change replays the paragraph from its start, at the new speed.
      ra.setRate(2);
      TestBed.tick();
      expect(cmp.clock().elapsed).toBe('0:31');
      vi.advanceTimersByTime(4_000);
      expect(cmp.clock().elapsed).toBe('0:35');
    });

    it('holds the dragged position while the head would otherwise move', () => {
      const { cmp, emit } = setup();
      emit().progress(1);
      emit().state('playing');
      TestBed.tick();
      cmp.onScrub(100);
      vi.advanceTimersByTime(5_000);
      expect(cmp.scrubValue()).toBe(100);
      expect(cmp.clock().elapsed).toBe('1:40');
    });
  });

  it('follows playback into the next chapter', () => {
    const { cmp, emit } = setup();
    emit().progress(5);
    expect(cmp.chapter()?.chapterId).toBe('b');
    expect(cmp.scrubValue()).toBe(1);
    expect(cmp.hasNextChapter()).toBe(false);
    expect(cmp.atEnd()).toBe(true);
  });

  function toggle(el: HTMLElement): HTMLButtonElement {
    return el.querySelector<HTMLButtonElement>('.bp-chapters-toggle')!;
  }

  it('opens the chapter list from its button, on the playing chapter, and plays the one picked', async () => {
    const { fixture, el, engine, ra } = setup();
    document.body.appendChild(el);
    expect(el.querySelector('.bp-chapters')).toBeNull();
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');

    toggle(el).click();
    await fixture.whenStable();
    fixture.detectChanges();
    const items = el.querySelectorAll<HTMLButtonElement>('.bp-chapter');
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(items[0]);
    expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
    expect(toggle(el).classList).toContain('is-open');

    items[1]!.click();
    fixture.detectChanges();
    expect(ra.index()).toBe(4);
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ startIndex: 4 }));
    expect(el.querySelector('.bp-chapters')).toBeNull();
    expect(document.activeElement).toBe(toggle(el));
    el.remove();
  });

  it('folds the list away when its button is pressed again', () => {
    const { fixture, el } = setup();
    toggle(el).click();
    fixture.detectChanges();
    expect(el.querySelector('.bp-chapters')).not.toBeNull();
    toggle(el).click();
    fixture.detectChanges();
    expect(el.querySelector('.bp-chapters')).toBeNull();
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes just the list, not the player', () => {
    const { fixture, el } = setup();
    document.body.appendChild(el);
    toggle(el).click();
    fixture.detectChanges();
    const reachedPage = vi.fn();
    document.body.addEventListener('keydown', reachedPage);
    el.querySelector('.bp-chapter')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(el.querySelector('.bp-chapters')).toBeNull();
    expect(reachedPage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(toggle(el));
    document.body.removeEventListener('keydown', reachedPage);
    el.remove();
  });

  it('play/pause and skip buttons drive the player', () => {
    const { el, engine, emit, fixture, ra } = setup();
    emit().state('playing');
    fixture.detectChanges();
    const play = el.querySelector<HTMLButtonElement>('.bp-play')!;
    expect(play.getAttribute('aria-label')).toBe('Pause');
    play.click();
    expect(engine.pause).toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('[aria-label="Next chapter"]')!.click();
    expect(ra.index()).toBe(4);
  });

  describe('book picker', () => {
    async function answerLibrary() {
      const http = TestBed.inject(HttpTestingController);
      http.expectOne('/api/series').flush([
        { id: 's2', title: 'Another' },
        { id: 's1', title: 'This Series' },
      ]);
      await new Promise(r => setTimeout(r)); // books are asked for once the series arrive
      http.expectOne('/api/books/series/s2').flush([{ id: 'b9', seriesId: 's2', title: 'Other Book' }]);
      http.expectOne('/api/books/series/s1').flush([
        { id: 'b1', seriesId: 's1', title: 'Book', sortOrder: 1 },
        { id: 'b2', seriesId: 's1', title: 'Sequel', sortOrder: 2 },
      ]);
      return http;
    }
    const booksToggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.bp-books-toggle')!;

    it('opens from the title on this book’s series, with where the reader is in each book', async () => {
      const { fixture, el } = setup();
      document.body.appendChild(el);
      const audio = TestBed.inject(BookAudioService);
      audio.positions.set([
        { bookId: 'b2', bookTitle: 'Sequel', chapterId: 'x', chapterTitle: 'Middle', blockIndex: 0, progress: 0.42, updatedAt: 1 },
        { bookId: 'b9', bookTitle: 'Other Book', chapterId: 'y', chapterTitle: 'End', blockIndex: 0, progress: 1, finished: true, updatedAt: 1 },
      ]);
      expect(booksToggle(el).textContent).toContain('Book');
      booksToggle(el).click();
      fixture.detectChanges();
      expect(el.querySelector('.bp-books .bp-panel-note mat-progress-spinner')).not.toBeNull();
      await answerLibrary();
      await fixture.whenStable();
      fixture.detectChanges();

      expect(booksToggle(el).getAttribute('aria-expanded')).toBe('true');
      const series = [...el.querySelectorAll<HTMLButtonElement>('.bp-series')];
      expect(series.map(s => s.querySelector('.bp-series-title')!.textContent)).toEqual(['This Series', 'Another']);
      expect(series.map(s => s.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
      const books = [...el.querySelectorAll<HTMLButtonElement>('.bp-book')];
      expect(books.map(b => b.querySelector('.bp-book-status')!.textContent)).toEqual(['Now playing · 0%', 'Middle · 42%']);
      expect(document.activeElement).toBe(books[0]);

      series[1]!.click();
      fixture.detectChanges();
      expect(el.querySelectorAll('.bp-book')[2]!.textContent).toContain('Finished');
      el.remove();
    });

    it('switches to the book picked, and closes', async () => {
      const { fixture, el } = setup();
      const audio = TestBed.inject(BookAudioService);
      const listen = vi.spyOn(audio, 'listen').mockImplementation(async id => {
        audio.nowPlaying.set({ bookId: id, seriesId: 's1', title: 'Sequel', coverUrl: null, chapterArt: {} });
      });
      booksToggle(el).click();
      await answerLibrary();
      await fixture.whenStable();
      fixture.detectChanges();
      el.querySelectorAll<HTMLButtonElement>('.bp-book')[1]!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(listen).toHaveBeenCalledWith('b2');
      expect(el.querySelector('.bp-books')).toBeNull();
    });

    it('just closes when the playing book is picked', async () => {
      const { fixture, el } = setup();
      const listen = vi.spyOn(TestBed.inject(BookAudioService), 'listen');
      booksToggle(el).click();
      await answerLibrary();
      await fixture.whenStable();
      fixture.detectChanges();
      el.querySelector<HTMLButtonElement>('.bp-book.is-current')!.click();
      fixture.detectChanges();
      expect(listen).not.toHaveBeenCalled();
      expect(el.querySelector('.bp-books')).toBeNull();
    });

    it('stays open with the error when the book can’t be loaded', async () => {
      const { fixture, el } = setup();
      const audio = TestBed.inject(BookAudioService);
      vi.spyOn(audio, 'listen').mockImplementation(async id => {
        audio.error.set({ bookId: id, message: 'Couldn’t load the book. Try again.' });
      });
      booksToggle(el).click();
      await answerLibrary();
      await fixture.whenStable();
      fixture.detectChanges();
      el.querySelectorAll<HTMLButtonElement>('.bp-book')[1]!.click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('.bp-books')).not.toBeNull();
      expect(el.querySelector('.bp-book-error')?.textContent).toContain('Couldn’t load');
    });

    it('says so when the books can’t be loaded', async () => {
      const { fixture, el } = setup();
      booksToggle(el).click();
      TestBed.inject(HttpTestingController).expectOne('/api/series').flush('no', { status: 500, statusText: 'err' });
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('.bp-books [role="alert"]')?.textContent).toContain('Couldn’t load your books');
    });

    it('only one panel is open at a time, and Escape closes just the picker', () => {
      const { fixture, el } = setup();
      document.body.appendChild(el);
      booksToggle(el).click();
      fixture.detectChanges();
      el.querySelector<HTMLButtonElement>('.bp-chapters-toggle')!.click();
      fixture.detectChanges();
      expect(el.querySelector('.bp-books')).toBeNull();
      expect(el.querySelector('.bp-chapters')).not.toBeNull();

      booksToggle(el).click();
      fixture.detectChanges();
      expect(el.querySelector('.bp-chapters')).toBeNull();
      const reachedPage = vi.fn();
      document.body.addEventListener('keydown', reachedPage);
      el.querySelector('.bp-books')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();
      expect(el.querySelector('.bp-books')).toBeNull();
      expect(reachedPage).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(booksToggle(el));
      document.body.removeEventListener('keydown', reachedPage);
      el.remove();
    });
  });
});
