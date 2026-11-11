import { AzureSpeechEngine } from './azure-speech-engine';
import { ReadAloudSegment, SpeechEngineListener, SpeechPlayRequest } from './read-aloud.model';

const seg = (text: string, blockIndex = 0): ReadAloudSegment =>
  ({ chapterId: 'c', chapterIndex: 0, chapterTitle: 'One', blockIndex, text });

function fakeAudio() {
  return {
    src: '',
    paused: true,
    onended: null as (() => void) | null,
    play: vi.fn(function (this: { paused: boolean }) { this.paused = false; return Promise.resolve(); }),
    pause: vi.fn(function (this: { paused: boolean }) { this.paused = true; }),
  };
}

function setup(source = vi.fn(async (text: string) => new Blob([text]))) {
  const audio = fakeAudio();
  let n = 0;
  const urls = { createObjectURL: vi.fn(() => `blob:${++n}`), revokeObjectURL: vi.fn() };
  const engine = new AzureSpeechEngine(audio as unknown as HTMLAudioElement, source, urls);
  const listener = { progress: vi.fn(), state: vi.fn(), error: vi.fn() } satisfies SpeechEngineListener;
  engine.setListener(listener);
  return { engine, audio, source, urls, listener };
}

const request = (over: Partial<SpeechPlayRequest> = {}): SpeechPlayRequest => ({
  segments: [seg('Title', -1), seg('First'), seg('Second')],
  startIndex: 1,
  voiceId: 'azure:en-US-JaneNeural',
  rate: 1.25,
  bookTitle: 'Book',
  ...over,
});

const flush = () => new Promise(r => setTimeout(r, 0));

describe('AzureSpeechEngine', () => {
  afterEach(() => vi.useRealTimers());

  it('plays the start paragraph and fetches the next one meanwhile', async () => {
    const { engine, audio, source, listener } = setup();
    engine.play(request());
    await flush();
    expect(listener.progress).toHaveBeenCalledWith(1);
    expect(source).toHaveBeenCalledWith('First', 'azure:en-US-JaneNeural', 1.25, expect.any(AbortSignal));
    expect(source).toHaveBeenCalledWith('Second', 'azure:en-US-JaneNeural', 1.25, expect.any(AbortSignal));
    expect(audio.src).toBe('blob:1');
    expect(audio.play).toHaveBeenCalled();
    expect(listener.state).toHaveBeenLastCalledWith('playing');
  });

  it('moves on when a paragraph ends, reusing the prefetched audio, then goes idle', async () => {
    vi.useFakeTimers();
    const { engine, audio, source, listener } = setup();
    engine.play(request());
    await vi.advanceTimersByTimeAsync(0);
    audio.onended!();
    await vi.advanceTimersByTimeAsync(300);
    expect(listener.progress).toHaveBeenLastCalledWith(2);
    expect(source).toHaveBeenCalledTimes(2);
    expect(audio.src).toBe('blob:2');
    audio.onended!();
    await vi.advanceTimersByTimeAsync(300);
    expect(listener.state).toHaveBeenLastCalledWith('idle');
  });

  it('pauses and resumes the loaded audio in place', async () => {
    const { engine, audio, listener } = setup();
    engine.play(request());
    await flush();
    engine.pause();
    expect(audio.pause).toHaveBeenCalled();
    expect(listener.state).toHaveBeenLastCalledWith('paused');
    audio.play.mockClear();
    engine.resume();
    await flush();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(listener.state).toHaveBeenLastCalledWith('playing');
  });

  it('drops audio that arrives after a jump', async () => {
    let release!: (b: Blob) => void;
    const source = vi.fn((text: string) => text === 'First' ? new Promise<Blob>(r => { release = r; }) : Promise.resolve(new Blob([text])));
    const { engine, audio } = setup(source);
    engine.play(request());
    engine.play(request({ startIndex: 2 }));
    await flush();
    const srcAfterJump = audio.src;
    release(new Blob(['late']));
    await flush();
    expect(audio.src).toBe(srcAfterJump);
  });

  it('refetches when the speed changes', async () => {
    const { engine, source, urls } = setup();
    engine.play(request());
    await flush();
    engine.play(request({ rate: 1 }));
    await flush();
    expect(source).toHaveBeenCalledWith('First', expect.any(String), 1, expect.any(AbortSignal));
    expect(urls.revokeObjectURL).toHaveBeenCalled();
  });

  it('reports a failed fetch and pauses so play retries', async () => {
    const { engine, listener, source } = setup(vi.fn().mockRejectedValue(new Error('The speech service is busy.')));
    engine.play(request());
    await flush();
    expect(listener.error).toHaveBeenCalledWith('Microsoft voice stopped: The speech service is busy.');
    expect(listener.state).toHaveBeenLastCalledWith('paused');
    source.mockResolvedValue(new Blob(['ok']));
    engine.resume();
    await flush();
    expect(listener.state).toHaveBeenLastCalledWith('playing');
  });

  it('stops, releasing audio', async () => {
    const { engine, listener, urls } = setup();
    engine.play(request());
    await flush();
    engine.stop();
    await flush();
    expect(listener.state).toHaveBeenLastCalledWith('idle');
    expect(urls.revokeObjectURL).toHaveBeenCalled();
  });

  it('primes the element with silence before anything plays', () => {
    const { engine, audio } = setup();
    engine.prime();
    expect(audio.src).toMatch(/^blob:/);
    expect(audio.play).toHaveBeenCalled();
  });
});
