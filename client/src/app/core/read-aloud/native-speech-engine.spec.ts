import { NATIVE_SPEECH_EVENT, QuillNativeSpeech } from '@app/core/native/quill-native';
import { NativeSpeechEngine } from './native-speech-engine';
import { buildSegments } from './read-aloud-segments';

describe('NativeSpeechEngine', () => {
  function setup(overrides: Partial<QuillNativeSpeech> = {}) {
    const speech: QuillNativeSpeech = {
      voices: vi.fn().mockResolvedValue([{ id: 'ava', name: 'Ava', lang: 'en-US', quality: 'premium' }]),
      play: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      status: vi.fn().mockResolvedValue({ index: 4, state: 'playing' }),
      ...overrides,
    };
    const engine = new NativeSpeechEngine(speech, window);
    const listener = { progress: vi.fn(), state: vi.fn(), error: vi.fn() };
    engine.setListener(listener);
    return { speech, engine, listener };
  }

  it('sends the queue to the app, with where each paragraph is in the book', () => {
    const { speech, engine } = setup();
    const segments = buildSegments([{ id: 'a', title: 'T', html: '<p>Hello</p>' }]);
    engine.play({ segments, startIndex: 1, voiceId: 'ava', rate: 1.5, bookTitle: 'Book', bookId: 'b1' });
    expect(speech.play).toHaveBeenCalledWith({
      segments: [
        { text: 'T', chapterTitle: 'T', chapterIndex: 0, chapterId: 'a', blockIndex: -1 },
        { text: 'Hello', chapterTitle: 'T', chapterIndex: 0, chapterId: 'a', blockIndex: 0 },
      ],
      startIndex: 1, voiceId: 'ava', rate: 1.5, bookTitle: 'Book', bookId: 'b1',
    });
    engine.pause(); engine.resume(); engine.stop();
    expect(speech.pause).toHaveBeenCalled();
    expect(speech.resume).toHaveBeenCalled();
    expect(speech.stop).toHaveBeenCalled();
  });

  it('relays events dispatched by the app', () => {
    const { listener } = setup();
    const fire = (detail: unknown) => window.dispatchEvent(new CustomEvent(NATIVE_SPEECH_EVENT, { detail }));
    fire({ type: 'progress', index: 7 });
    fire({ type: 'state', state: 'paused' });
    fire({ type: 'error', message: 'nope' });
    fire(null);
    expect(listener.progress).toHaveBeenCalledWith(7);
    expect(listener.state).toHaveBeenCalledWith('paused');
    expect(listener.error).toHaveBeenCalledWith('nope');
  });

  it('catches up on status, tolerating a failing bridge', async () => {
    const { engine, listener } = setup();
    await engine.resync();
    expect(listener.progress).toHaveBeenCalledWith(4);
    expect(listener.state).toHaveBeenCalledWith('playing');
    const broken = setup({ status: vi.fn().mockRejectedValue(new Error('x')) });
    await expect(broken.engine.resync()).resolves.toBeUndefined();
  });

  it('returns no voices when the app fails to list them', async () => {
    const { engine } = setup({ voices: vi.fn().mockRejectedValue(new Error('x')) });
    expect(await engine.getVoices()).toEqual([]);
  });

  it('reports what the app is playing, or null when an older app can\'t say', async () => {
    const { engine } = setup({ status: vi.fn().mockResolvedValue({ index: 4, state: 'paused', count: 9, bookId: 'b1' }) });
    expect(await engine.status()).toEqual({ index: 4, state: 'paused', count: 9, bookId: 'b1' });

    const old = setup();
    expect(await old.engine.status()).toBeNull();

    const broken = setup({ status: vi.fn().mockRejectedValue(new Error('no bridge')) });
    expect(await broken.engine.status()).toBeNull();
  });
});
