import { RoutedSpeechEngine } from './routed-speech-engine';
import { SpeechEngine, SpeechEngineListener, SpeechPlayRequest } from './read-aloud.model';

function fake() {
  let listener!: SpeechEngineListener;
  const engine = {
    kind: 'web' as const,
    setListener: vi.fn((l: SpeechEngineListener) => { listener = l; }),
    getVoices: vi.fn().mockResolvedValue([{ id: 'ava', name: 'Ava', lang: 'en-US', quality: 'premium' }]),
    prime: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  } satisfies SpeechEngine;
  return { engine, emit: () => listener };
}

const req = (voiceId: string | null): SpeechPlayRequest =>
  ({ segments: [], startIndex: 0, voiceId, rate: 1, bookTitle: '' });

describe('RoutedSpeechEngine', () => {
  function setup() {
    const device = fake();
    const azure = fake();
    const routed = new RoutedSpeechEngine(device.engine, azure.engine);
    const listener = { progress: vi.fn(), state: vi.fn(), error: vi.fn() };
    routed.setListener(listener);
    return { device, azure, routed, listener };
  }

  it('sends Microsoft voices to Azure and others to the device, stopping the one it leaves', () => {
    const { device, azure, routed } = setup();
    routed.play(req('ava'));
    expect(device.engine.play).toHaveBeenCalled();
    routed.play(req('azure:en-US-JaneNeural'));
    expect(azure.engine.play).toHaveBeenCalled();
    expect(device.engine.stop).toHaveBeenCalled();
    routed.pause();
    expect(azure.engine.pause).toHaveBeenCalled();
    expect(device.engine.pause).not.toHaveBeenCalled();
  });

  it('only passes on events from the engine that is playing', () => {
    const { device, azure, routed, listener } = setup();
    routed.play(req('azure:en-US-JaneNeural'));
    device.emit().state('idle');
    expect(listener.state).not.toHaveBeenCalled();
    azure.emit().progress(3);
    expect(listener.progress).toHaveBeenCalledWith(3);
  });

  it('primes both engines and lists device voices', async () => {
    const { device, azure, routed } = setup();
    routed.prime();
    expect(device.engine.prime).toHaveBeenCalled();
    expect(azure.engine.prime).toHaveBeenCalled();
    expect(await routed.getVoices()).toHaveLength(1);
    expect(routed.supportsAzure).toBe(true);
  });
});
