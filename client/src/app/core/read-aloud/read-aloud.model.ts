/** A chapter handed to the read-aloud player. */
export interface ReadAloudChapter {
  id: string;
  title: string;
  /** The chapter's HTML (live editor content when it's open). */
  html: string;
}

/** One spoken unit: a chapter title or one paragraph of a chapter. */
export interface ReadAloudSegment {
  chapterId: string;
  /** Position of the chapter in the queue (0-based). */
  chapterIndex: number;
  chapterTitle: string;
  /** The paragraph's index in parseContentBlocks() order; -1 for the chapter title. */
  blockIndex: number;
  text: string;
}

export type VoiceQuality = 'default' | 'enhanced' | 'premium';

export interface ReadAloudVoice {
  id: string;
  name: string;
  /** BCP 47 tag, e.g. "en-US". */
  lang: string;
  quality: VoiceQuality;
}

export type ReadAloudState = 'idle' | 'playing' | 'paused';

export interface SpeechPlayRequest {
  segments: readonly ReadAloudSegment[];
  startIndex: number;
  voiceId: string | null;
  /** 1 = normal speed. */
  rate: number;
  bookTitle: string;
}

export interface SpeechEngineListener {
  /** The engine started speaking segment `index`. */
  progress(index: number): void;
  state(state: ReadAloudState): void;
  error(message: string): void;
}

/** Where speech actually comes from: the browser or the iPhone app. */
export interface SpeechEngine {
  readonly kind: 'web' | 'native';
  setListener(listener: SpeechEngineListener): void;
  getVoices(): Promise<ReadAloudVoice[]>;
  /** Called synchronously from a click so a later async play() is still allowed
   *  (Safari only lets a user gesture start speech). */
  prime?(): void;
  /** Replaces whatever is playing and starts at `startIndex`. */
  play(request: SpeechPlayRequest): void;
  pause(): void;
  resume(): void;
  stop(): void;
}
