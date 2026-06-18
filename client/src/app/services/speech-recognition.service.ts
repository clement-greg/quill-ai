import { Injectable, signal } from '@angular/core';

// ── Minimal Web Speech API typings ──────────────────────────────────────────
// The DOM lib doesn't ship types for SpeechRecognition, so we declare the slice
// we use rather than reaching for `any`.
interface SpeechRecognitionAlternative {
  readonly transcript: string;
}
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/**
 * Thin wrapper around the browser's Web Speech API for dictation. Lets a caller
 * stream live speech-to-text (push-to-talk): `start()` opens the mic and invokes
 * `onUpdate` with the running transcript; `stop()` ends the session. Unsupported
 * browsers report `supported === false` so callers can hide the affordance.
 */
@Injectable({ providedIn: 'root' })
export class SpeechRecognitionService {
  private readonly ctor: SpeechRecognitionCtor | null = this.resolveCtor();

  /** True when the browser exposes the Web Speech API. */
  readonly supported = this.ctor !== null;
  /** True while the mic is open and listening. */
  readonly recording = signal(false);
  /** Last error code reported by the API (e.g. 'not-allowed'), else null. */
  readonly error = signal<string | null>(null);

  private recognition: SpeechRecognitionLike | null = null;

  private resolveCtor(): SpeechRecognitionCtor | null {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  }

  /**
   * Begins listening. `onUpdate` fires on every recognition event with the full
   * transcript of the current session (final text plus the latest interim guess).
   */
  start(onUpdate: (transcript: string) => void): void {
    if (!this.ctor || this.recording()) return;

    const rec = new this.ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    let finalText = '';
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      onUpdate((finalText + interim).trim());
    };
    rec.onerror = (event) => {
      this.error.set(event.error);
      this.recording.set(false);
      this.recognition = null;
    };
    rec.onend = () => {
      this.recording.set(false);
      this.recognition = null;
    };

    this.recognition = rec;
    this.error.set(null);
    this.recording.set(true);
    rec.start();
  }

  /** Stops listening; the final `onUpdate` for any pending speech still fires. */
  stop(): void {
    this.recognition?.stop();
  }
}
