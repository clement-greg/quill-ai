import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MatDialog } from '@angular/material/dialog';
import { Subject } from 'rxjs';
import { SPEECH_ENGINE, ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { SpeechEngine, SpeechEngineListener } from '@app/core/read-aloud/read-aloud.model';
import { ChapterDraftService } from '@app/features/chapters/chapter-edit/chapter-draft.service';
import { ListeningPosition } from '@shared/models/listening.model';
import { BookAudioService, proxyImageUrl, SAVE_INTERVAL_MS } from './book-audio.service';

const BOOK = { id: 'b1', title: 'The Book', seriesId: 's', thumnailUrl: 'https://blob/x/thumb.png', originalUrl: 'https://blob/x/cover.png' };
const CHAPTERS = [
  { id: 'c2', title: 'Two', content: '<p>B1</p><p>B2</p>', sortOrder: 2, imageUrl: 'https://blob/x/two.png', imageThumbnailUrl: 'https://blob/x/two_thumb.webp' },
  { id: 'c1', title: 'One', content: '<p>A1</p><p>A2</p>', sortOrder: 1 },
  { id: 'c3', title: 'Three', content: '', sortOrder: 3, imageThumbnailUrl: 'https://blob/x/three_thumb.webp' },
  { id: 'cx', title: 'Gone', content: '<p>X</p>', sortOrder: 0, archived: true },
];

function position(over: Partial<ListeningPosition> = {}): ListeningPosition {
  return { bookId: 'b1', bookTitle: 'The Book', chapterId: 'c2', chapterTitle: 'Two', blockIndex: 1, progress: 0.8, updatedAt: 1, ...over };
}

function fakeEngine() {
  let listener!: SpeechEngineListener;
  const engine = {
    kind: 'web' as const,
    setListener: vi.fn((l: SpeechEngineListener) => { listener = l; }),
    getVoices: vi.fn().mockResolvedValue([]),
    prime: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  } satisfies SpeechEngine;
  return { engine, emit: () => listener };
}

describe('BookAudioService', () => {
  function setup(engine: SpeechEngine | null = fakeEngine().engine) {
    localStorage.clear();
    const closed = new Subject<void>();
    const dialogRef = { close: vi.fn(() => closed.next()), afterClosed: () => closed };
    const dialog = { open: vi.fn(() => dialogRef) };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: SPEECH_ENGINE, useValue: engine },
        { provide: MatDialog, useValue: dialog },
        { provide: ChapterDraftService, useValue: { resolvePendingDraft: vi.fn(async (c: { id: string }) => c.id === 'c1' ? { content: '<p>Draft</p>' } : null) } },
      ],
    });
    const svc = TestBed.inject(BookAudioService);
    const http = TestBed.inject(HttpTestingController);
    const ra = TestBed.inject(ReadAloudService);
    return { svc, http, ra, dialog, dialogRef };
  }

  /** Answers the requests listen() makes. */
  async function answerListen(http: HttpTestingController, saved: ListeningPosition[] = []) {
    http.expectOne('/api/books/b1').flush(BOOK);
    http.expectOne('/api/chapters/book/b1').flush(CHAPTERS);
    http.expectOne('/api/listening').flush(saved);
    await new Promise(r => setTimeout(r));
    TestBed.tick();
  }

  afterEach(() => vi.useRealTimers());

  it('plays the book from the start the first time, in chapter order with drafts, and opens the player', async () => {
    const { engine } = fakeEngine();
    const { svc, http, dialog } = setup(engine);
    const done = svc.listen('b1');
    expect(engine.prime).toHaveBeenCalled();
    expect(svc.loading()).toBe('b1');
    await answerListen(http);
    await done;
    const req = engine.play.mock.calls[0]![0];
    expect(req.startIndex).toBe(0);
    expect(req.segments.map((s: { text: string }) => s.text)).toEqual(['One', 'Draft', 'Two', 'B1', 'B2', 'Three']);
    expect(svc.nowPlaying()).toEqual({
      bookId: 'b1',
      seriesId: 's',
      title: 'The Book',
      coverUrl: '/api/image/cover.png',
      // Full image preferred, thumbnail when that's all there is, none for c1.
      chapterArt: { c2: '/api/image/two.png', c3: '/api/image/three_thumb.webp' },
    });
    expect(dialog.open).toHaveBeenCalledTimes(1);
    expect(svc.expanded()).toBe(true);
    expect(svc.loading()).toBeNull();
  });

  it('resumes from the saved paragraph', async () => {
    const { engine } = fakeEngine();
    const { svc, http } = setup(engine);
    const done = svc.listen('b1');
    await answerListen(http, [position()]);
    await done;
    expect(engine.play.mock.calls[0]![0].startIndex).toBe(4); // c2 paragraph 2
  });

  it('starts over after finishing, or when asked', async () => {
    const { engine } = fakeEngine();
    const { svc, http } = setup(engine);
    const done = svc.listen('b1');
    await answerListen(http, [position({ finished: true })]);
    await done;
    expect(engine.play.mock.calls[0]![0].startIndex).toBe(0);

    const again = svc.listen('b1', { fromStart: true });
    http.expectOne('/api/books/b1').flush(BOOK);
    http.expectOne('/api/chapters/book/b1').flush(CHAPTERS);
    await again;
    expect(engine.play.mock.calls.at(-1)![0].startIndex).toBe(0);
  });

  it('just reopens the player (and resumes) when the book is already loaded', async () => {
    const { engine, emit } = fakeEngine();
    const { svc, http, dialog, dialogRef } = setup(engine);
    const done = svc.listen('b1');
    await answerListen(http);
    await done;
    emit().state('paused');
    svc.minimize();
    expect(dialogRef.close).toHaveBeenCalled();
    expect(svc.expanded()).toBe(false);
    await svc.listen('b1');
    expect(engine.resume).toHaveBeenCalled();
    expect(dialog.open).toHaveBeenCalledTimes(2);
    http.expectNone('/api/books/b1');
  });

  it('reports a book with nothing to read, or one that fails to load', async () => {
    const { svc, http, dialog } = setup();
    let done = svc.listen('b1');
    http.expectOne('/api/books/b1').flush(BOOK);
    http.expectOne('/api/chapters/book/b1').flush([]);
    http.expectOne('/api/listening').flush([]);
    await done;
    expect(svc.error()).toEqual({ bookId: 'b1', message: 'This book has no chapters to read yet.' });

    done = svc.listen('b1');
    http.expectOne('/api/books/b1').flush('nope', { status: 500, statusText: 'err' });
    http.expectOne('/api/chapters/book/b1').flush(CHAPTERS);
    await done;
    expect(svc.error()?.message).toContain('Couldn’t load');
    expect(svc.loading()).toBeNull();
    expect(dialog.open).not.toHaveBeenCalled();
  });

  it('does nothing without a speech engine', async () => {
    const { svc, http } = setup(null);
    await svc.listen('b1');
    http.expectNone('/api/books/b1');
  });

  it('saves the position right away when paused, and at most every interval while playing', async () => {
    const { engine, emit } = fakeEngine();
    const { svc, http, ra } = setup(engine);
    const done = svc.listen('b1');
    await answerListen(http);
    await done;
    // Saved once on load, before the engine reports it's playing.
    http.match('/api/listening/b1').forEach(r => r.flush({}));
    vi.useFakeTimers();
    emit().state('playing');
    TestBed.tick();
    http.expectNone('/api/listening/b1');
    emit().progress(3);
    TestBed.tick();
    expect(svc.positions()[0]).toMatchObject({ bookId: 'b1', chapterId: 'c2', blockIndex: 0 });
    expect(svc.resumable()?.bookId).toBe('b1');
    vi.advanceTimersByTime(SAVE_INTERVAL_MS);
    const put = http.expectOne('/api/listening/b1');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toMatchObject({ chapterId: 'c2', blockIndex: 0, bookTitle: 'The Book', coverUrl: BOOK.thumnailUrl });
    expect(typeof put.request.body.blockText).toBe('string');
    expect(put.request.body.blockText.length).toBeGreaterThan(0);
    expect(put.request.body.progress).toBeGreaterThan(0);
    put.flush({});

    emit().progress(4);
    emit().state('paused');
    TestBed.tick();
    http.expectOne('/api/listening/b1').flush({});

    ra.stop();
    TestBed.tick();
    http.expectNone('/api/listening/b1');
    expect(svc.nowPlaying()).toBeNull();
  });

  it('marks the book finished at the end, so it is no longer offered to resume', async () => {
    const { engine, emit } = fakeEngine();
    const { svc, http } = setup(engine);
    const done = svc.listen('b1');
    await answerListen(http);
    await done;
    http.match('/api/listening/b1').forEach(r => r.flush({}));
    emit().progress(4);
    emit().state('idle');
    TestBed.tick();
    const put = http.expectOne('/api/listening/b1');
    expect(put.request.body).toMatchObject({ finished: true, progress: 1 });
    expect(svc.resumable()).toBeNull();
  });

  it('loads positions once unless forced, and retries after a failure', async () => {
    const { svc, http } = setup();
    let p = svc.loadPositions();
    http.expectOne('/api/listening').flush('x', { status: 500, statusText: 'err' });
    await p;
    expect(svc.positions()).toEqual([]);
    p = svc.loadPositions();
    http.expectOne('/api/listening').flush([position(), position({ bookId: 'b2', finished: true })]);
    await p;
    await svc.loadPositions();
    http.expectNone('/api/listening');
    expect(svc.positionFor('b2')?.finished).toBe(true);
    expect(svc.positionFor('zz')).toBeNull();
    expect(svc.resumable()?.bookId).toBe('b1');
    p = svc.loadPositions(true);
    http.expectOne('/api/listening').flush([]);
    await p;
    expect(svc.resumable()).toBeNull();
  });
  describe('when the iPhone app is still reading a book after the page reloads', () => {
    function nativeEngine(status: unknown) {
      const { engine, emit } = fakeEngine();
      const native = { ...engine, kind: 'native' as const, status: vi.fn().mockResolvedValue(status) };
      return { engine: native, emit };
    }

    async function answerAdopt(http: HttpTestingController) {
      await vi.waitFor(() => http.expectOne('/api/books/b1').flush(BOOK));
      http.expectOne('/api/chapters/book/b1').flush(CHAPTERS);
      await vi.waitFor(() => expect(TestBed.inject(ReadAloudService).active()).toBe(true));
    }

    it('takes over at the app\'s exact place without restarting it', async () => {
      const { engine } = nativeEngine({ index: 3, state: 'paused', count: 6, bookId: 'b1' });
      const { svc, http, ra } = setup(engine);
      await answerAdopt(http);

      expect(ra.current()).toMatchObject({ chapterId: 'c2', blockIndex: 0 });
      expect(ra.state()).toBe('paused');
      expect(svc.nowPlaying()?.title).toBe('The Book');
      expect(engine.play).not.toHaveBeenCalled();

      // Pressing play resumes the app where it is, rather than the saved position.
      await svc.listen('b1');
      expect(engine.resume).toHaveBeenCalled();
      expect(engine.play).not.toHaveBeenCalled();
      http.match(() => true).forEach(req => req.flush({}));
    });

    it('starts normally when the app\'s queue doesn\'t match the book any more', async () => {
      const { engine } = nativeEngine({ index: 3, state: 'paused', count: 9, bookId: 'b1' });
      const { svc, http, ra } = setup(engine);
      await vi.waitFor(() => http.expectOne('/api/books/b1').flush(BOOK));
      http.expectOne('/api/chapters/book/b1').flush(CHAPTERS);
      await new Promise(r => setTimeout(r));
      expect(ra.active()).toBe(false);
      expect(svc.nowPlaying()).toBeNull();
    });

    it('leaves things alone when the app is idle or can\'t say', async () => {
      for (const status of [{ index: 0, state: 'idle', count: 6, bookId: 'b1' }, null]) {
        TestBed.resetTestingModule();
        const { engine } = nativeEngine(status);
        const { http, ra } = setup(engine);
        await new Promise(r => setTimeout(r));
        http.expectNone('/api/books/b1');
        expect(ra.active()).toBe(false);
      }
    });
  });
});

describe('proxyImageUrl', () => {
  it('maps a blob URL to the image proxy', () => {
    expect(proxyImageUrl('https://acct.blob/container/a.png')).toBe('/api/image/a.png');
    expect(proxyImageUrl(undefined)).toBeNull();
    expect(proxyImageUrl('')).toBeNull();
  });

});
