import { NATIVE_SPEECH_EVENT, NativeSpeechEvent, QuillNativeSpeech } from '@app/core/native/quill-native';
import { ReadAloudVoice, SpeechEngine, SpeechEngineListener, SpeechPlayRequest } from './read-aloud.model';

const NOOP_LISTENER: SpeechEngineListener = { progress: () => {}, state: () => {}, error: () => {} };

/**
 * Hands the whole queue to the iPhone app, which speaks it with AVSpeechSynthesizer
 * so playback continues in the background and the lock screen / CarPlay controls
 * work even while this page is suspended.
 */
export class NativeSpeechEngine implements SpeechEngine {
  readonly kind = 'native' as const;
  private listener = NOOP_LISTENER;

  constructor(private readonly speech: QuillNativeSpeech, private readonly win: Window) {
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
      segments: request.segments.map(s => ({ text: s.text, chapterTitle: s.chapterTitle, chapterIndex: s.chapterIndex })),
      startIndex: request.startIndex,
      voiceId: request.voiceId,
      rate: request.rate,
      bookTitle: request.bookTitle,
    });
  }

  pause(): void { this.speech.pause(); }
  resume(): void { this.speech.resume(); }
  stop(): void { this.speech.stop(); }

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
