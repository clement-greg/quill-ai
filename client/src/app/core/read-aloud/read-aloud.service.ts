import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { getQuillNative } from '@app/core/native/quill-native';
import { AzureSpeechClient } from './azure-speech-client';
import { AzureSpeechEngine } from './azure-speech-engine';
import { NativeSpeechEngine } from './native-speech-engine';
import {
  EngineStatus, isAzureVoice, PLAYHEAD_TEXT_MAX, ReadAloudChapter, ReadAloudPlayhead, ReadAloudSegment, ReadAloudState, ReadAloudVoice, SpeechEngine,
} from './read-aloud.model';
import { buildSegments, findSegmentIndex, nextChapterStart, previousChapterStart, sortVoices } from './read-aloud-segments';
import { RoutedSpeechEngine } from './routed-speech-engine';
import { WebSpeechEngine } from './web-speech-engine';

/** The iPhone app's voices when available, else the browser's (plus Microsoft
 *  voices through the server); null if neither exists. */
export const SPEECH_ENGINE = new InjectionToken<SpeechEngine | null>('SPEECH_ENGINE', {
  providedIn: 'root',
  factory: () => {
    const win = inject(DOCUMENT).defaultView;
    const native = getQuillNative()?.speech;
    if (native && win) return new NativeSpeechEngine(native, win);
    if (win?.speechSynthesis && typeof win.Audio === 'function') {
      const azure = inject(AzureSpeechClient);
      return new RoutedSpeechEngine(
        new WebSpeechEngine(win.speechSynthesis),
        new AzureSpeechEngine(new win.Audio(), (text, voice, rate, signal) => azure.synthesize(text, voice, rate, signal)),
      );
    }
    if (win?.speechSynthesis) return new WebSpeechEngine(win.speechSynthesis);
    return null;
  },
});

export const READ_ALOUD_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const RATE_KEY = 'quill_read_aloud_rate';
const VOICE_KEY = 'quill_read_aloud_voice';
/** Saved when the reader picks "System default", so it isn't replaced by the Microsoft default. */
const SYSTEM_VOICE = 'system';

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
  private readonly azure = inject(AzureSpeechClient);
  private readonly storage = safeStorage(inject(DOCUMENT).defaultView);

  readonly supported = this.engine !== null;
  readonly engineKind = this.engine?.kind ?? null;
  readonly state = signal<ReadAloudState>('idle');
  readonly segments = signal<readonly ReadAloudSegment[]>([]);
  readonly index = signal(0);
  readonly rate = signal(readRate(this.storage));
  readonly voiceId = signal<string | null>(readVoice(this.storage, this.voiceKey()));
  /** Device voices (and Microsoft voices in `azureVoices`), for the voice picker. */
  readonly voices = signal<ReadAloudVoice[]>([]);
  /** Microsoft Azure neural voices, when the server offers them and this engine can play them. */
  readonly azureVoices = signal<ReadAloudVoice[]>([]);
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

  /** Where a book is being read (playing or paused), or null when no book is
   *  loaded or it was read to the end. */
  playhead(): ReadAloudPlayhead | null {
    const bookId = this.bookId();
    const current = this.current();
    if (!bookId || !current || this.finished()) return null;
    return {
      bookId,
      bookTitle: this.bookTitle,
      chapterId: current.chapterId,
      chapterTitle: current.chapterTitle,
      blockIndex: current.blockIndex,
      text: current.blockIndex >= 0 ? current.text.slice(0, PLAYHEAD_TEXT_MAX) : '',
    };
  }
  /** Set when the position, voice or speed changed while paused, so resume replays from `index`. */
  private restartOnResume = false;
  private voicesLoaded = false;
  /** The reader has never picked a voice (so the Microsoft default may apply). */
  private voiceUnset = this.storage?.getItem(this.voiceKey()) == null;

  constructor() {
    // Learn early whether Microsoft voices are on, so the first play already uses Jane.
    if (this.engine?.supportsAzure) void this.loadAzureVoices();
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

  /** playhead(), plus the word being spoken when the engine can say (the
   *  iPhone app can; a browser can't, and the note goes on the paragraph's last word). */
  async livePlayhead(): Promise<ReadAloudPlayhead | null> {
    const playhead = this.playhead();
    if (!playhead || playhead.blockIndex < 0) return playhead;
    const status = await this.engineStatus().catch(() => null);
    const segment = this.current();
    const word = status?.word;
    if (!word || !segment || status.index !== this.index()) return playhead;
    const text = segment.text.slice(word.offset, word.offset + word.length);
    return text.trim() ? { ...playhead, wordOffset: word.offset, word: text } : playhead;
  }

  /** What the engine is playing on its own (the iPhone app), if it can say. */
  engineStatus(): Promise<EngineStatus | null> {
    return this.engine?.status?.() ?? Promise.resolve(null);
  }

  /**
   * Takes over a book the engine is already reading (the page reloaded while
   * the iPhone app kept going) without restarting it, so play and pause carry
   * on from exactly where it is. Returns false if the chapters don't line up
   * with what's queued.
   */
  attach(chapters: readonly ReadAloudChapter[], options: ReadAloudStartOptions, status: EngineStatus): boolean {
    if (!this.engine || status.state === 'idle') return false;
    const segments = buildSegments(chapters);
    if (!segments.length || segments.length !== status.count || !segments[status.index]) return false;
    this.bookTitle = options.bookTitle;
    this.bookId.set(options.bookId ?? null);
    this.segments.set(segments);
    this.index.set(status.index);
    this.error.set(null);
    this.finished.set(false);
    this.restartOnResume = false;
    this.state.set(status.state);
    void this.loadVoices();
    return true;
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
    this.voiceUnset = false;
    this.storage?.setItem(this.voiceKey(), id ?? SYSTEM_VOICE);
    this.applySettingChange();
  }

  async loadVoices(): Promise<void> {
    if (!this.engine || this.voicesLoaded) return;
    const language = this.storage ? navigatorLanguage() : 'en-US';
    const [device] = await Promise.all([this.engine.getVoices(), this.loadAzureVoices()]);
    const voices = sortVoices(device, language);
    this.voicesLoaded = voices.length > 0;
    this.voices.set(voices);
    const saved = this.voiceId();
    if (saved && !isAzureVoice(saved) && voices.length && !voices.some(v => v.id === saved)) this.voiceId.set(null);
  }

  /** Fetches the Microsoft voices (once) and makes Jane the voice for readers who never picked one. */
  private async loadAzureVoices(): Promise<void> {
    if (!this.engine?.supportsAzure) return;
    const azure = await this.azure.voices();
    const language = this.storage ? navigatorLanguage() : 'en-US';
    this.azureVoices.set(sortVoices(azure.voices, language));
    const current = this.voiceId();
    if (this.voiceUnset && !current && azure.defaultVoiceId) {
      this.voiceId.set(azure.defaultVoiceId);
    } else if (isAzureVoice(current) && !azure.enabled) {
      // Microsoft voices were switched off on the server: fall back to the device.
      this.voiceId.set(null);
    }
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
      bookId: this.bookId(),
    });
  }

  /** Voices differ between the iPhone app and browsers, so each remembers its own. */
  private voiceKey(): string {
    return `${VOICE_KEY}_${this.engineKind ?? 'none'}`;
  }
}

/** The saved voice: null for the device default (picked, or never picked). */
function readVoice(storage: Storage | null, key: string): string | null {
  const saved = storage?.getItem(key) ?? null;
  return saved === SYSTEM_VOICE ? null : saved;
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
