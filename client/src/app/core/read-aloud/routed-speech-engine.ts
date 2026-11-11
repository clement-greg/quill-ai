import { isAzureVoice, ReadAloudVoice, SpeechEngine, SpeechEngineListener, SpeechPlayRequest } from './read-aloud.model';

const NOOP_LISTENER: SpeechEngineListener = { progress: () => {}, state: () => {}, error: () => {} };

/**
 * The browser's player: device voices through the Web Speech API, Microsoft
 * voices through Azure. Each play goes to whichever engine owns its voice, and
 * only that engine's events reach the player.
 */
export class RoutedSpeechEngine implements SpeechEngine {
  readonly kind = 'web' as const;
  readonly supportsAzure = true;
  private listener = NOOP_LISTENER;
  private active: SpeechEngine;

  constructor(private readonly device: SpeechEngine, private readonly azure: SpeechEngine) {
    this.active = device;
    for (const engine of [device, azure]) {
      engine.setListener({
        progress: i => { if (this.active === engine) this.listener.progress(i); },
        state: s => { if (this.active === engine) this.listener.state(s); },
        error: m => { if (this.active === engine) this.listener.error(m); },
      });
    }
  }

  setListener(listener: SpeechEngineListener): void {
    this.listener = listener;
  }

  getVoices(): Promise<ReadAloudVoice[]> {
    return this.device.getVoices();
  }

  prime(): void {
    // Either engine may end up playing; both need the click.
    this.device.prime?.();
    this.azure.prime?.();
  }

  play(request: SpeechPlayRequest): void {
    const target = isAzureVoice(request.voiceId) ? this.azure : this.device;
    if (target !== this.active) {
      const previous = this.active;
      this.active = target;
      previous.stop();
    }
    target.play(request);
  }

  pause(): void { this.active.pause(); }
  resume(): void { this.active.resume(); }
  stop(): void { this.active.stop(); }
}
