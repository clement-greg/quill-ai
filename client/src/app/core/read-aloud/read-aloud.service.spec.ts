import { TestBed } from '@angular/core/testing';
import { ReadAloudService, SPEECH_ENGINE } from './read-aloud.service';
import { SpeechEngine, SpeechEngineListener } from './read-aloud.model';

const BOOK = [
  { id: 'a', title: 'One', html: '<p>A1</p><p>A2</p><p>A3</p>' },
  { id: 'b', title: 'Two', html: '<p>B1</p>' },
];

function fakeEngine() {
  let listener!: SpeechEngineListener;
  const engine = {
    kind: 'web' as const,
    setListener: vi.fn((l: SpeechEngineListener) => { listener = l; }),
    getVoices: vi.fn().mockResolvedValue([
      { id: 'fr', name: 'Amelie', lang: 'fr-FR', quality: 'default' },
      { id: 'ava', name: 'Ava', lang: 'en-US', quality: 'premium' },
    ]),
    prime: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  } satisfies SpeechEngine;
  return { engine, emit: () => listener };
}

describe('ReadAloudService', () => {
  function setup(engine: SpeechEngine | null = fakeEngine().engine) {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [{ provide: SPEECH_ENGINE, useValue: engine }] });
    return TestBed.inject(ReadAloudService);
  }

  it('starts at the requested paragraph and plays the whole queue', () => {
    const { engine } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: 'Book', chapterId: 'a', blockIndex: 1 });
    expect(svc.active()).toBe(true);
    expect(svc.index()).toBe(2);
    expect(engine.play).toHaveBeenCalledWith(expect.objectContaining({ startIndex: 2, rate: 1, bookTitle: 'Book' }));
    expect(engine.play.mock.calls[0]![0].segments).toHaveLength(6);
    expect(svc.chapterCount()).toBe(2);
    expect(svc.chapterProgress()).toEqual({ paragraph: 2, total: 3 });
  });

  it('ignores a start with nothing to read', () => {
    const { engine } = fakeEngine();
    const svc = setup(engine);
    svc.start([], { bookTitle: '' });
    expect(svc.active()).toBe(false);
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('tracks engine progress and state, and toggles play/pause', () => {
    const { engine, emit } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: '' });
    emit().progress(3);
    emit().state('playing');
    expect(svc.current()?.text).toBe('A3');
    svc.playPause();
    expect(engine.pause).toHaveBeenCalled();
    emit().state('paused');
    svc.playPause();
    expect(engine.resume).toHaveBeenCalled();
  });

  it('seeks immediately while playing, but defers while paused', () => {
    const { engine, emit } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: '' });
    emit().state('playing');
    svc.nextChapter();
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ startIndex: 4 }));
    emit().state('paused');
    engine.play.mockClear();
    svc.previousParagraph();
    expect(svc.index()).toBe(3);
    expect(engine.play).not.toHaveBeenCalled();
    svc.playPause();
    expect(engine.resume).not.toHaveBeenCalled();
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ startIndex: 3 }));
  });

  it('clamps seeking and skips to the previous chapter', () => {
    const { engine, emit } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: '', chapterId: 'b' });
    emit().state('paused');
    svc.seek(99);
    expect(svc.index()).toBe(5);
    svc.seek(-4);
    expect(svc.index()).toBe(0);
    svc.seek(5);
    svc.previousChapter(); // one paragraph in: back a chapter
    expect(svc.index()).toBe(0);
    svc.nextChapter();
    expect(svc.index()).toBe(4);
    svc.nextChapter(); // already in the last chapter
    expect(svc.index()).toBe(4);
  });

  it('restarts from the beginning after finishing', () => {
    const { engine, emit } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: '' });
    emit().progress(5);
    emit().state('idle');
    svc.playPause();
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ startIndex: 0 }));
  });

  it('knows which book is loaded and when it finished, until stopped', () => {
    const { engine, emit } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: 'Book', bookId: 'b1' });
    expect(svc.bookId()).toBe('b1');
    expect(svc.finished()).toBe(false);
    emit().state('idle');
    expect(svc.finished()).toBe(true);
    svc.seek(1);
    expect(svc.finished()).toBe(false);
    svc.stop();
    expect(svc.bookId()).toBeNull();
    svc.start(BOOK, { bookTitle: 'Chapter only' });
    expect(svc.bookId()).toBeNull();
  });

  it('reports where a whole book is being read, for notes', () => {
    const { engine, emit } = fakeEngine();
    const svc = setup(engine);
    expect(svc.playhead()).toBeNull();
    svc.start(BOOK, { bookTitle: 'Book', bookId: 'b1' });
    expect(svc.playhead()).toEqual({
      bookId: 'b1', bookTitle: 'Book', chapterId: 'a', chapterTitle: 'One', blockIndex: -1, text: '',
    });
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ bookId: 'b1' }));
    emit().progress(2);
    expect(svc.playhead()).toMatchObject({ chapterId: 'a', blockIndex: 1, text: 'A2' });
    emit().state('paused');
    expect(svc.playhead()).not.toBeNull();
    emit().state('idle'); // read to the end
    expect(svc.playhead()).toBeNull();
    svc.start(BOOK, { bookTitle: 'Chapter only' });
    expect(svc.playhead()).toBeNull();
  });

  it('takes over a queue the engine is already playing, without restarting it', () => {
    const { engine } = fakeEngine();
    const svc = setup(engine);
    // BOOK has 6 segments: two titles and four paragraphs.
    expect(svc.attach(BOOK, { bookTitle: 'Book', bookId: 'b1' }, { index: 2, state: 'playing', count: 6, bookId: 'b1' })).toBe(true);
    expect(svc.current()).toMatchObject({ chapterId: 'a', blockIndex: 1 });
    expect(svc.state()).toBe('playing');
    expect(svc.playhead()?.bookId).toBe('b1');
    expect(engine.play).not.toHaveBeenCalled();
    svc.playPause();
    expect(engine.pause).toHaveBeenCalled();
  });

  it('refuses to take over a queue that doesn\'t match or isn\'t playing', () => {
    const svc = setup();
    expect(svc.attach(BOOK, { bookTitle: 'B' }, { index: 0, state: 'playing', count: 5, bookId: null })).toBe(false);
    expect(svc.attach(BOOK, { bookTitle: 'B' }, { index: 9, state: 'paused', count: 6, bookId: null })).toBe(false);
    expect(svc.attach(BOOK, { bookTitle: 'B' }, { index: 0, state: 'idle', count: 6, bookId: null })).toBe(false);
    expect(svc.active()).toBe(false);
  });

  it('remembers speed and voice, replaying from the current paragraph', () => {
    const { engine, emit } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: '' });
    emit().state('playing');
    svc.setRate(1.5);
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ rate: 1.5 }));
    svc.setVoice('ava');
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ voiceId: 'ava' }));
    expect(localStorage.getItem('quill_read_aloud_rate')).toBe('1.5');
    expect(localStorage.getItem('quill_read_aloud_voice_web')).toBe('ava');
    svc.setVoice(null);
    expect(localStorage.getItem('quill_read_aloud_voice_web')).toBeNull();
  });

  it('loads voices in the reader language and drops a saved voice that no longer exists', async () => {
    const { engine } = fakeEngine();
    localStorage.clear();
    localStorage.setItem('quill_read_aloud_voice_web', 'gone');
    TestBed.configureTestingModule({ providers: [{ provide: SPEECH_ENGINE, useValue: engine }] });
    const svc = TestBed.inject(ReadAloudService);
    expect(svc.voiceId()).toBe('gone');
    await svc.loadVoices();
    expect(svc.voices().map(v => v.id)).toEqual(['ava']);
    expect(svc.voiceId()).toBeNull();
  });

  it('records engine errors and clears everything on stop', () => {
    const { engine, emit } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: '' });
    emit().error('boom');
    expect(svc.error()).toBe('boom');
    svc.stop();
    expect(engine.stop).toHaveBeenCalled();
    expect(svc.active()).toBe(false);
    expect(svc.error()).toBeNull();
  });

  it('is inert without an engine', () => {
    const svc = setup(null);
    expect(svc.supported).toBe(false);
    svc.prime();
    svc.start(BOOK, { bookTitle: '' });
    svc.playPause();
    expect(svc.active()).toBe(false);
  });
});
