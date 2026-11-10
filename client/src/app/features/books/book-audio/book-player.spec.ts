import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { MatDialog } from '@angular/material/dialog';
import { SPEECH_ENGINE, ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { SpeechEngine, SpeechEngineListener } from '@app/core/read-aloud/read-aloud.model';
import { BookPlayerComponent } from './book-player';
import { BookAudioService } from './book-audio.service';
import { ChapterDraftService } from '@app/features/chapters/chapter-edit/chapter-draft.service';

const BOOK = [
  { id: 'a', title: 'Arrival', html: '<p>one two three</p><p>four five</p><p>six</p>' },
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
    TestBed.inject(BookAudioService).nowPlaying.set({ bookId: 'b1', title: 'Book', coverUrl: '/api/image/cover.png', chapterArt: { b: '/api/image/b.png' } });
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
    TestBed.inject(BookAudioService).nowPlaying.set({ bookId: 'b1', title: 'Book', coverUrl: null, chapterArt: {} });
    fixture.detectChanges();
    expect(el.querySelector('.bp-art img')).toBeNull();
    expect(el.querySelector('.bp-art mat-icon')?.textContent).toContain('auto_stories');
  });

  it('scrubs within the current chapter, previewing the paragraph before seeking', () => {
    const { cmp, ra, fixture, el } = setup();
    expect(cmp.scrubMax()).toBe(3); // title + 3 paragraphs
    cmp.onScrub(2);
    fixture.detectChanges();
    expect(el.querySelector('.bp-preview')?.textContent).toContain('four five');
    expect(ra.index()).toBe(0);
    cmp.commitScrub(2);
    expect(ra.index()).toBe(2);
    expect(cmp.scrubbing()).toBeNull();
    expect(cmp.scrubValue()).toBe(2);
    expect(cmp.clock().elapsed).not.toBe('0:00');
  });

  it('follows playback into the next chapter', () => {
    const { cmp, emit } = setup();
    emit().progress(5);
    expect(cmp.chapter()?.chapterId).toBe('b');
    expect(cmp.scrubValue()).toBe(1);
    expect(cmp.hasNextChapter()).toBe(false);
    expect(cmp.atEnd()).toBe(true);
  });

  it('lists the chapters and plays the one picked', () => {
    const { cmp, fixture, el, engine, ra } = setup();
    cmp.showChapters.set(true);
    fixture.detectChanges();
    const items = el.querySelectorAll<HTMLButtonElement>('.bp-chapter');
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute('aria-current')).toBe('true');
    items[1]!.click();
    expect(ra.index()).toBe(4);
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ startIndex: 4 }));
    expect(cmp.showChapters()).toBe(false);
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
});
