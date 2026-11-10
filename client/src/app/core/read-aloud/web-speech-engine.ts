import { ReadAloudVoice, SpeechEngine, SpeechEngineListener, SpeechPlayRequest, VoiceQuality } from './read-aloud.model';
import { splitIntoChunks } from './read-aloud-segments';

/** Guesses how natural a browser voice sounds from its name. */
export function webVoiceQuality(voice: Pick<SpeechSynthesisVoice, 'name' | 'localService'>): VoiceQuality {
  const name = voice.name.toLowerCase();
  // Edge's free neural voices ("Microsoft Aria Online (Natural)") and Apple's premium voices.
  if (name.includes('natural') || name.includes('premium')) return 'premium';
  if (name.includes('enhanced') || name.includes('neural') || (!voice.localService && name.includes('google'))) return 'enhanced';
  return 'default';
}

const NOOP_LISTENER: SpeechEngineListener = { progress: () => {}, state: () => {}, error: () => {} };

/**
 * Speaks with the browser's Web Speech API, one sentence-sized chunk at a time.
 * Pause cancels and resume restarts the current chunk: `speechSynthesis.pause()`
 * is unreliable (it silently fails with Chrome's online voices).
 */
export class WebSpeechEngine implements SpeechEngine {
  readonly kind = 'web' as const;
  private listener = NOOP_LISTENER;
  private request: SpeechPlayRequest | null = null;
  private index = 0;
  private chunks: string[] = [];
  private chunkIndex = 0;
  /** Bumped on every play/pause/stop so callbacks from cancelled utterances are ignored. */
  private generation = 0;
  /** Held so the utterance isn't garbage collected mid-speech (a Chrome bug drops its events). */
  private current: SpeechSynthesisUtterance | null = null;

  constructor(private readonly synth: SpeechSynthesis) {}

  setListener(listener: SpeechEngineListener): void {
    this.listener = listener;
  }

  async getVoices(): Promise<ReadAloudVoice[]> {
    let voices = this.synth.getVoices();
    if (!voices.length) {
      // Chrome and Edge load voices asynchronously.
      voices = await new Promise<SpeechSynthesisVoice[]>(resolve => {
        const done = () => { this.synth.removeEventListener('voiceschanged', done); resolve(this.synth.getVoices()); };
        this.synth.addEventListener('voiceschanged', done);
        setTimeout(done, 1500);
      });
    }
    return voices.map(v => ({ id: v.voiceURI, name: v.name, lang: v.lang, quality: webVoiceQuality(v) }));
  }

  prime(): void {
    if (this.synth.speaking || this.request) return;
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0;
    this.synth.speak(silent);
  }

  play(request: SpeechPlayRequest): void {
    this.cancel();
    this.request = request;
    this.speakSegment(request.startIndex);
  }

  pause(): void {
    if (!this.request) return;
    this.cancel();
    this.listener.state('paused');
  }

  resume(): void {
    if (!this.request) return;
    if (!this.chunks.length) { this.speakSegment(this.index); return; }
    this.generation++;
    this.speakChunk();
  }

  stop(): void {
    this.cancel();
    this.request = null;
    this.listener.state('idle');
  }

  private cancel(): void {
    this.generation++;
    this.current = null;
    this.synth.cancel();
  }

  private speakSegment(index: number): void {
    const segments = this.request?.segments ?? [];
    if (index >= segments.length) {
      this.request = null;
      this.chunks = [];
      this.listener.state('idle');
      return;
    }
    this.index = index;
    this.chunks = splitIntoChunks(segments[index]!.text);
    this.chunkIndex = 0;
    this.listener.progress(index);
    if (!this.chunks.length) { this.speakSegment(index + 1); return; }
    this.speakChunk();
  }

  private speakChunk(): void {
    const request = this.request;
    if (!request) return;
    const generation = this.generation;
    const utterance = new SpeechSynthesisUtterance(this.chunks[this.chunkIndex]);
    const voice = request.voiceId ? this.synth.getVoices().find(v => v.voiceURI === request.voiceId) : undefined;
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = request.rate;
    utterance.onend = () => {
      if (generation !== this.generation) return;
      this.chunkIndex++;
      if (this.chunkIndex < this.chunks.length) this.speakChunk();
      else this.speakSegment(this.index + 1);
    };
    utterance.onerror = event => {
      if (generation !== this.generation || event.error === 'interrupted' || event.error === 'canceled') return;
      this.request = null;
      this.listener.error(event.error === 'not-allowed'
        ? 'The browser blocked speech. Press play again.'
        : `Speech stopped (${event.error}).`);
      this.listener.state('idle');
    };
    this.current = utterance;
    this.synth.speak(utterance);
    this.listener.state('playing');
  }
}
