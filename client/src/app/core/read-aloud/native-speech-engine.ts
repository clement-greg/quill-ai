import { NATIVE_SPEECH_EVENT, NativeSpeechEvent, QuillNativeSpeech } from '@app/core/native/quill-native';
import { EngineStatus, ReadAloudVoice, SpeechEngine, SpeechEngineListener, SpeechPlayRequest } from './read-aloud.model';

const NOOP_LISTENER: SpeechEngineListener = { progress: () => {}, state: () => {}, error: () => {} };

/**
 * Hands the whole queue to the iPhone app, which speaks it with AVSpeechSynthesizer
 * so playback continues in the background and the lock screen / CarPlay controls
 * work even while this page is suspended.
 */
export class NativeSpeechEngine implements SpeechEngine {
  readonly kind = 'native' as const;
  /** App builds that can fetch and play Microsoft voices say so on the bridge. */
  readonly supportsAzure: boolean;
  private listener = NOOP_LISTENER;

  constructor(private readonly speech: QuillNativeSpeech, private readonly win: Window) {
    this.supportsAzure = speech.azure === true;
    win.addEventListener(NATIVE_SPEECH_EVENT, event => this.onEvent((event as CustomEvent<NativeSpeechEvent>).detail));
    // Events can be missed while the app is backgrounded; catch up on return.
    win.document.addEventListener('visibilitychange', () => {
      if (win.document.visibilityState === 'visible') void this.resync();
    });
  }

  setListener(listener: SpeechEngineListener): void {
    this.listener = listener;
  }

  async getVoices(): Promise<ReadAloudVoice[]> {
    try {
      return await this.speech.voices();
    } catch {
      return [];
    }
  }

  play(request: SpeechPlayRequest): void {
    this.speech.play({
      segments: request.segments.map(s => ({
        text: s.text, chapterTitle: s.chapterTitle, chapterIndex: s.chapterIndex, chapterId: s.chapterId, blockIndex: s.blockIndex,
      })),
      startIndex: request.startIndex,
      voiceId: request.voiceId,
      rate: request.rate,
      bookTitle: request.bookTitle,
      bookId: request.bookId ?? null,
    });
  }

  pause(): void { this.speech.pause(); }
  resume(): void { this.speech.resume(); }
  stop(): void { this.speech.stop(); }

  /** What the app is playing, or null when it can't say (older app build). */
  async status(): Promise<EngineStatus | null> {
    try {
      const s = await this.speech.status();
      if (typeof s.count !== 'number') return null;
      const word = Number.isInteger(s.wordOffset) && Number.isInteger(s.wordLength) && s.wordLength! > 0
        ? { offset: s.wordOffset!, length: s.wordLength! }
        : undefined;
      return { index: s.index, state: s.state, count: s.count, bookId: s.bookId ?? null, ...(word ? { word } : {}) };
    } catch {
      return null;
    }
  }

  async resync(): Promise<void> {
    try {
      const status = await this.speech.status();
      this.listener.progress(status.index);
      this.listener.state(status.state);
    } catch {
      // Older app build or bridge unavailable; nothing to catch up on.
    }
  }

  private onEvent(event: NativeSpeechEvent | null | undefined): void {
    if (!event) return;
    if (event.type === 'progress') this.listener.progress(event.index);
    else if (event.type === 'state') this.listener.state(event.state);
    else if (event.type === 'error') this.listener.error(event.message);
  }
}
