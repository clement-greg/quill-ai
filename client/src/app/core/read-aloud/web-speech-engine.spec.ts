import { buildSegments } from './read-aloud-segments';
import { SpeechPlayRequest } from './read-aloud.model';
import { WebSpeechEngine, webVoiceQuality } from './web-speech-engine';

class FakeUtterance {
  voice: unknown = null;
  lang = '';
  rate = 1;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

function fakeSynth(voices: { voiceURI: string; name: string; lang: string; localService: boolean }[] = []) {
  const spoken: FakeUtterance[] = [];
  const listeners: (() => void)[] = [];
  return {
    spoken,
    speaking: false,
    speak: vi.fn((u: FakeUtterance) => spoken.push(u)),
    cancel: vi.fn(),
    getVoices: vi.fn(() => voices),
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: vi.fn(),
    fireVoicesChanged: () => listeners.forEach(fn => fn()),
  };
}

describe('WebSpeechEngine', () => {
  beforeEach(() => vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance));
  afterEach(() => vi.unstubAllGlobals());

  const segments = buildSegments([{ id: 'a', title: 'Title', html: '<p>First one. Second one.</p><p>Next.</p>' }]);
  const request = (over: Partial<SpeechPlayRequest> = {}): SpeechPlayRequest =>
    ({ segments, startIndex: 0, voiceId: null, rate: 1.25, bookTitle: 'B', ...over });

  function setup(voices?: Parameters<typeof fakeSynth>[0]) {
    const synth = fakeSynth(voices);
    const engine = new WebSpeechEngine(synth as unknown as SpeechSynthesis);
    const listener = { progress: vi.fn(), state: vi.fn(), error: vi.fn() };
    engine.setListener(listener);
    return { synth, engine, listener };
  }

  it('speaks segments chunk by chunk, reports progress, then goes idle', () => {
    const { synth, engine, listener } = setup();
    engine.play(request());
    expect(listener.progress).toHaveBeenLastCalledWith(0);
    expect(synth.spoken[0]!.text).toBe('Title');
    expect(synth.spoken[0]!.rate).toBe(1.25);
    synth.spoken[0]!.onend!();
    expect(listener.progress).toHaveBeenLastCalledWith(1);
    expect(synth.spoken[1]!.text).toBe('First one. Second one.');
    synth.spoken[1]!.onend!();
    synth.spoken[2]!.onend!();
    expect(listener.state).toHaveBeenLastCalledWith('idle');
  });

  it('uses the chosen voice', () => {
    const { synth, engine } = setup([{ voiceURI: 'v1', name: 'Aria', lang: 'en-US', localService: false }]);
    engine.play(request({ voiceId: 'v1' }));
    expect((synth.spoken[0]!.voice as { name: string }).name).toBe('Aria');
    expect(synth.spoken[0]!.lang).toBe('en-US');
  });

  it('ignores events from cancelled utterances', () => {
    const { synth, engine, listener } = setup();
    engine.play(request());
    const stale = synth.spoken[0]!;
    engine.play(request({ startIndex: 2 }));
    listener.progress.mockClear();
    stale.onend!();
    stale.onerror!({ error: 'synthesis-failed' });
    expect(listener.progress).not.toHaveBeenCalled();
    expect(listener.error).not.toHaveBeenCalled();
  });

  it('pauses by cancelling and resumes the same chunk', () => {
    const { synth, engine, listener } = setup();
    engine.play(request({ startIndex: 1 }));
    engine.pause();
    expect(synth.cancel).toHaveBeenCalled();
    expect(listener.state).toHaveBeenLastCalledWith('paused');
    engine.resume();
    expect(synth.spoken.at(-1)!.text).toBe('First one. Second one.');
    expect(listener.state).toHaveBeenLastCalledWith('playing');
  });

  it('reports errors other than interruptions', () => {
    const { synth, engine, listener } = setup();
    engine.play(request());
    synth.spoken[0]!.onerror!({ error: 'interrupted' });
    expect(listener.error).not.toHaveBeenCalled();
    synth.spoken[0]!.onerror!({ error: 'not-allowed' });
    expect(listener.error).toHaveBeenCalledWith(expect.stringContaining('blocked'));
    expect(listener.state).toHaveBeenLastCalledWith('idle');
  });

  it('stop goes idle; pause/resume without a queue do nothing', () => {
    const { synth, engine, listener } = setup();
    engine.pause();
    engine.resume();
    expect(synth.speak).not.toHaveBeenCalled();
    engine.stop();
    expect(listener.state).toHaveBeenLastCalledWith('idle');
  });

  it('primes with a silent utterance only when idle', () => {
    const { synth, engine } = setup();
    engine.prime();
    expect(synth.spoken[0]!.volume).toBe(0);
    engine.play(request());
    synth.speak.mockClear();
    engine.prime();
    expect(synth.speak).not.toHaveBeenCalled();
  });

  it('waits for voices to load', async () => {
    const voices: Parameters<typeof fakeSynth>[0] = [];
    const { synth, engine } = setup(voices);
    const pending = engine.getVoices();
    voices.push({ voiceURI: 'x', name: 'Microsoft Aria Online (Natural)', lang: 'en-US', localService: false });
    synth.fireVoicesChanged();
    expect(await pending).toEqual([{ id: 'x', name: 'Microsoft Aria Online (Natural)', lang: 'en-US', quality: 'premium' }]);
  });
});

describe('webVoiceQuality', () => {
  it('ranks voices by name hints', () => {
    expect(webVoiceQuality({ name: 'Samantha (Enhanced)', localService: true })).toBe('enhanced');
    expect(webVoiceQuality({ name: 'Google US English', localService: false })).toBe('enhanced');
    expect(webVoiceQuality({ name: 'Ava (Premium)', localService: true })).toBe('premium');
    expect(webVoiceQuality({ name: 'Fred', localService: true })).toBe('default');
  });
});
