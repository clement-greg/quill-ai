import { TestBed } from '@angular/core/testing';
import { ReadAloudService, SPEECH_ENGINE } from './read-aloud.service';
import { AzureSpeechClient, AzureVoices } from './azure-speech-client';
import { SpeechEngine, SpeechEngineListener } from './read-aloud.model';
import { dialogueBlocks } from './dialogue-paragraphs';

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

  it('adds the word being spoken when the engine knows it', async () => {
    const { engine } = fakeEngine();
    const status = vi.fn();
    const svc = setup({ ...engine, status });
    svc.start(BOOK, { bookTitle: 'Book', bookId: 'b1' });
    svc.seek(2); // "A2"
    status.mockResolvedValue({ index: 2, state: 'paused', count: 6, bookId: 'b1', word: { offset: 0, length: 2 } });
    expect(await svc.livePlayhead()).toMatchObject({ blockIndex: 1, wordOffset: 0, word: 'A2' });

    // A stale answer about another paragraph, or none: paragraph only.
    status.mockResolvedValue({ index: 4, state: 'paused', count: 6, bookId: 'b1', word: { offset: 0, length: 2 } });
    expect(await svc.livePlayhead()).not.toHaveProperty('word');
    status.mockResolvedValue(null);
    expect(await svc.livePlayhead()).not.toHaveProperty('word');
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
    expect(localStorage.getItem('quill_read_aloud_voice_web')).toBe('system');
  });

  it('ignores character voices on an engine without Microsoft voices', () => {
    const { engine } = fakeEngine();
    const svc = setup(engine);
    svc.start(BOOK, { bookTitle: '', cast: { narratorVoiceId: 'azure:x', voices: { a: 'azure:y' } } });
    expect(svc.cast()).toBeNull();
    expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ voiceId: null }));
  });

  describe('Microsoft voices', () => {
    const JANE = 'azure:en-US-JaneNeural';
    const ENABLED: AzureVoices = {
      enabled: true,
      defaultVoiceId: JANE,
      voices: [
        { id: 'azure:fr-FR-DeniseNeural', name: 'Denise', lang: 'fr-FR', quality: 'premium', provider: 'azure', localeName: 'x', gender: 'Female' as const, hd: false, multilingual: false, personalities: [], scenarios: [] },
        { id: JANE, name: 'Jane', lang: 'en-US', quality: 'premium', provider: 'azure', localeName: 'x', gender: 'Female' as const, hd: false, multilingual: false, personalities: [], scenarios: [] },
      ],
    };

    function setupAzure(azure: AzureVoices, saved?: string) {
      const { engine, emit } = fakeEngine();
      const azureEngine = { ...engine, supportsAzure: true };
      localStorage.clear();
      if (saved) localStorage.setItem('quill_read_aloud_voice_web', saved);
      const client = { voices: vi.fn().mockResolvedValue(azure) };
      TestBed.configureTestingModule({
        providers: [{ provide: SPEECH_ENGINE, useValue: azureEngine }, { provide: AzureSpeechClient, useValue: client }],
      });
      return { svc: TestBed.inject(ReadAloudService), engine: azureEngine, client, emit };
    }

    it('uses Jane until the reader picks a voice', async () => {
      const { svc, engine } = setupAzure(ENABLED);
      await vi.waitFor(() => expect(svc.voiceId()).toBe(JANE));
      expect(svc.azureVoices().map(v => v.id)).toEqual([JANE]);
      svc.start(BOOK, { bookTitle: '' });
      expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ voiceId: JANE }));
    });

    it('keeps a reader\'s choice of the system default, or of a device voice', async () => {
      const system = setupAzure(ENABLED, 'system');
      await system.svc.loadVoices();
      expect(system.svc.voiceId()).toBeNull();
      TestBed.resetTestingModule();
      const device = setupAzure(ENABLED, 'ava');
      await device.svc.loadVoices();
      expect(device.svc.voiceId()).toBe('ava');
    });

    it('keeps a saved Microsoft voice through device voice cleanup', async () => {
      const { svc } = setupAzure(ENABLED, 'azure:en-US-AndrewNeural');
      await svc.loadVoices();
      expect(svc.voiceId()).toBe('azure:en-US-AndrewNeural');
    });

    it('falls back to the device when the server has no Microsoft voices', async () => {
      const { svc } = setupAzure({ enabled: false, defaultVoiceId: null, voices: [] }, JANE);
      await svc.loadVoices();
      expect(svc.voiceId()).toBeNull();
      expect(svc.azureVoices()).toEqual([]);
    });

    it('keeps every language for the gallery and remembers the default', async () => {
      const { svc } = setupAzure(ENABLED);
      await svc.loadVoices();
      expect(svc.azureCatalog()).toHaveLength(2);
      expect(svc.azureDefaultId()).toBe(JANE);
    });

    it('reads narration in the narrator\'s voice, falling back to the reader\'s', async () => {
      const { svc, engine } = setupAzure(ENABLED, 'azure:en-US-AndrewNeural');
      await svc.loadVoices();
      svc.start(BOOK, { bookTitle: '', cast: { narratorVoiceId: JANE, voices: {} } });
      expect(svc.narratorVoiceId()).toBe(JANE);
      expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ voiceId: JANE }));
      svc.start(BOOK, { bookTitle: '', cast: { narratorVoiceId: null, voices: { ann: JANE } } });
      expect(engine.play).toHaveBeenLastCalledWith(expect.objectContaining({ voiceId: 'azure:en-US-AndrewNeural' }));
      svc.stop();
      expect(svc.cast()).toBeNull();
    });

    it('gives character voices to the segments', async () => {
      const { svc } = setupAzure(ENABLED);
      await svc.loadVoices();
      const html = '<p>"Hi," Ann said.</p>';
      const key = dialogueBlocks(html)[0]!.key!;
      svc.start([{ id: 'c', title: 'C', html, dialogue: { [key]: ['ann'] } }], {
        bookTitle: '', cast: { voices: { ann: JANE, bob: 'not-azure' } },
      });
      expect(svc.cast()).toEqual({ narratorVoiceId: null, voices: { ann: JANE } });
      expect(svc.segments()[1]!.parts?.[0]).toEqual({ text: '"Hi,"', voiceId: JANE });
    });

    it('pins and unpins voices, remembering them', () => {
      const { svc } = setupAzure(ENABLED);
      svc.togglePin(JANE);
      svc.togglePin('azure:en-GB-SoniaNeural');
      expect(svc.pinnedVoices()).toEqual([JANE, 'azure:en-GB-SoniaNeural']);
      svc.togglePin(JANE);
      expect(JSON.parse(localStorage.getItem('quill_read_aloud_pinned_voices')!)).toEqual(['azure:en-GB-SoniaNeural']);
    });

    it('ignores a corrupt pin list', () => {
      localStorage.clear();
      localStorage.setItem('quill_read_aloud_pinned_voices', '{nope');
      TestBed.configureTestingModule({ providers: [{ provide: SPEECH_ENGINE, useValue: null }] });
      expect(TestBed.inject(ReadAloudService).pinnedVoices()).toEqual([]);
    });

    it('doesn\'t ask the server when the engine can\'t play them', async () => {
      const { engine } = fakeEngine();
      const client = { voices: vi.fn() };
      localStorage.clear();
      TestBed.configureTestingModule({
        providers: [{ provide: SPEECH_ENGINE, useValue: engine }, { provide: AzureSpeechClient, useValue: client }],
      });
      await TestBed.inject(ReadAloudService).loadVoices();
      expect(client.voices).not.toHaveBeenCalled();
    });
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
