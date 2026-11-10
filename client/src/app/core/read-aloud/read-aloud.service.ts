import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { getQuillNative } from '@app/core/native/quill-native';
import { NativeSpeechEngine } from './native-speech-engine';
import { ReadAloudChapter, ReadAloudSegment, ReadAloudState, ReadAloudVoice, SpeechEngine } from './read-aloud.model';
import { buildSegments, findSegmentIndex, nextChapterStart, previousChapterStart, sortVoices } from './read-aloud-segments';
import { WebSpeechEngine } from './web-speech-engine';

/** The iPhone app's voices when available, else the browser's; null if neither exists. */
export const SPEECH_ENGINE = new InjectionToken<SpeechEngine | null>('SPEECH_ENGINE', {
  providedIn: 'root',
  factory: () => {
    const win = inject(DOCUMENT).defaultView;
    const native = getQuillNative()?.speech;
    if (native && win) return new NativeSpeechEngine(native, win);
    if (win?.speechSynthesis) return new WebSpeechEngine(win.speechSynthesis);
    return null;
  },
});

export const READ_ALOUD_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const RATE_KEY = 'quill_read_aloud_rate';
const VOICE_KEY = 'quill_read_aloud_voice';

export interface ReadAloudStartOptions {
  bookTitle: string;
  /** The book being read, so its listening position can be remembered. */
  bookId?: string;
  /** Chapter to start in (defaults to the first). */
  chapterId?: string;
  /** Paragraph to start at within that chapter; omitted or -1 starts with the chapter title. */
  blockIndex?: number | null;
}

/** App-wide read-aloud player: the queue, where it is, and the controls. */
@Injectable({ providedIn: 'root' })
export class ReadAloudService {
  private readonly engine = inject(SPEECH_ENGINE);
  private readonly storage = safeStorage(inject(DOCUMENT).defaultView);

  readonly supported = this.engine !== null;
  readonly engineKind = this.engine?.kind ?? null;
  readonly state = signal<ReadAloudState>('idle');
  readonly segments = signal<readonly ReadAloudSegment[]>([]);
  readonly index = signal(0);
  readonly rate = signal(readRate(this.storage));
  readonly voiceId = signal<string | null>(this.storage?.getItem(this.voiceKey()) ?? null);
  readonly voices = signal<ReadAloudVoice[]>([]);
  readonly error = signal<string | null>(null);
  /** The book loaded in the player (null when it isn't a whole book, or nothing is loaded). */
  readonly bookId = signal<string | null>(null);
  /** Reading reached the end of the queue. */
  readonly finished = signal(false);

  /** True while a queue is loaded (the player bar is showing). */
  readonly active = computed(() => this.segments().length > 0);
  readonly current = computed(() => this.segments()[this.index()] ?? null);
  readonly chapterCount = computed(() => (this.segments().at(-1)?.chapterIndex ?? -1) + 1);
  /** Paragraph position within the current chapter, for the player label. */
  readonly chapterProgress = computed(() => {
    const cur = this.current();
    if (!cur) return null;
    const inChapter = this.segments().filter(s => s.chapterIndex === cur.chapterIndex && s.blockIndex >= 0);
    return { paragraph: Math.max(0, cur.blockIndex) + 1, total: inChapter.length };
  });

  private bookTitle = '';
  /** Set when the position, voice or speed changed while paused, so resume replays from `index`. */
  private restartOnResume = false;
  private voicesLoaded = false;

  constructor() {
    this.engine?.setListener({
      progress: index => this.index.set(index),
      state: state => {
        if (state === 'idle' && this.active()) this.finished.set(true);
        this.state.set(state);
      },
      error: message => this.error.set(message),
    });
  }

  /** Call from the click handler before any await that precedes start(). */
  prime(): void {
    this.engine?.prime?.();
  }

  /** Loads the chapters and starts reading at the requested place. */
  start(chapters: readonly ReadAloudChapter[], options: ReadAloudStartOptions): void {
    if (!this.engine) return;
    const segments = buildSegments(chapters);
    if (!segments.length) return;
    this.bookTitle = options.bookTitle;
    this.bookId.set(options.bookId ?? null);
    this.segments.set(segments);
    const index = options.chapterId ? findSegmentIndex(segments, options.chapterId, options.blockIndex) : 0;
    this.playFrom(index);
    void this.loadVoices();
  }

  playPause(): void {
    if (!this.engine || !this.active()) return;
    const state = this.state();
    if (state === 'playing') this.engine.pause();
    else if (state === 'paused' && !this.restartOnResume) this.engine.resume();
    else this.playFrom(this.finished() ? 0 : this.index());
  }

  /** Stops and closes the player. */
  stop(): void {
    this.engine?.stop();
    this.segments.set([]);
    this.index.set(0);
    this.state.set('idle');
    this.error.set(null);
    this.restartOnResume = false;
    this.finished.set(false);
    this.bookId.set(null);
  }

  seek(index: number): void {
    const last = this.segments().length - 1;
    if (last < 0) return;
    const target = Math.min(Math.max(index, 0), last);
    if (this.state() === 'playing') {
      this.playFrom(target);
    } else {
      this.index.set(target);
      this.finished.set(false);
      this.restartOnResume = true;
    }
  }

  nextParagraph(): void { this.seek(this.index() + 1); }
  previousParagraph(): void { this.seek(this.index() - 1); }

  nextChapter(): void {
    const next = nextChapterStart(this.segments(), this.index());
    if (next >= 0) this.seek(next);
  }

  previousChapter(): void {
    this.seek(previousChapterStart(this.segments(), this.index()));
  }

  setRate(rate: number): void {
    this.rate.set(rate);
    this.storage?.setItem(RATE_KEY, String(rate));
    this.applySettingChange();
  }

  setVoice(id: string | null): void {
    this.voiceId.set(id);
    if (id) this.storage?.setItem(this.voiceKey(), id);
    else this.storage?.removeItem(this.voiceKey());
    this.applySettingChange();
  }

  async loadVoices(): Promise<void> {
    if (!this.engine || this.voicesLoaded) return;
    const language = this.storage ? navigatorLanguage() : 'en-US';
    const voices = sortVoices(await this.engine.getVoices(), language);
    this.voicesLoaded = voices.length > 0;
    this.voices.set(voices);
    const saved = this.voiceId();
    if (saved && voices.length && !voices.some(v => v.id === saved)) this.voiceId.set(null);
  }

  private applySettingChange(): void {
    if (!this.active()) return;
    if (this.state() === 'playing') this.playFrom(this.index());
    else this.restartOnResume = true;
  }

  private playFrom(index: number): void {
    if (!this.engine) return;
    this.index.set(index);
    this.error.set(null);
    this.finished.set(false);
    this.restartOnResume = false;
    this.engine.play({
      segments: this.segments(),
      startIndex: index,
      voiceId: this.voiceId(),
      rate: this.rate(),
      bookTitle: this.bookTitle,
    });
  }

  /** Voices differ between the iPhone app and browsers, so each remembers its own. */
  private voiceKey(): string {
    return `${VOICE_KEY}_${this.engineKind ?? 'none'}`;
  }
}

function readRate(storage: Storage | null): number {
  const value = Number(storage?.getItem(RATE_KEY));
  return (READ_ALOUD_RATES as readonly number[]).includes(value) ? value : 1;
}

function navigatorLanguage(): string {
  return (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
}

/** localStorage, or null where it's blocked (private mode, sandboxed frames). */
function safeStorage(win: Window | null): Storage | null {
  try {
    const storage = win?.localStorage ?? null;
    storage?.getItem(RATE_KEY);
    return storage;
  } catch {
    return null;
  }
}
