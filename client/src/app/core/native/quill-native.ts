/**
 * Bridge injected by the iOS wrapper app (ios/QuillAI/WebBridge.swift). Absent
 * in a browser and in the desktop app, so its presence is how the client knows
 * it is running inside the iPhone app.
 */
export interface QuillNative {
  platform: 'ios';
  /** Runs Google Sign-In in Apple's web-auth sheet and resolves with the Google ID token. */
  signInWithGoogle(): Promise<string>;
  /**
   * Hands the current refresh token to the app (stored in the Keychain) so its
   * Siri commands can call the API without the web view; null on sign-out.
   */
  setSession(refreshToken: string | null): void;
  /**
   * Read-aloud with the iPhone's own voices. Plays in the background and shows
   * on the lock screen, Control Center and CarPlay. Absent in older app builds.
   * The app reports progress with a `quillspeech` window event (NativeSpeechEvent).
   */
  speech?: QuillNativeSpeech;
}

export interface NativeSpeechSegment {
  text: string;
  chapterTitle: string;
  chapterIndex: number;
  /** With blockIndex, where in the book this is, so Siri can add a note at the play head. */
  chapterId: string;
  blockIndex: number;
}

/** Where the app's player is. `count` and `bookId` come from app builds that report them. */
export interface NativeSpeechStatus {
  index: number;
  state: 'idle' | 'playing' | 'paused';
  /** How many segments are queued. */
  count?: number;
  /** The book being read, when it's a whole book. */
  bookId?: string;
}

export interface QuillNativeSpeech {
  voices(): Promise<{ id: string; name: string; lang: string; quality: 'default' | 'enhanced' | 'premium' }[]>;
  play(request: {
    segments: NativeSpeechSegment[];
    startIndex: number;
    voiceId: string | null;
    rate: number;
    bookTitle: string;
    bookId: string | null;
  }): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** Where playback is now (events may be missed while the app is in the background). */
  status(): Promise<NativeSpeechStatus>;
}

export type NativeSpeechEvent =
  | { type: 'progress'; index: number }
  | { type: 'state'; state: 'idle' | 'playing' | 'paused' }
  | { type: 'error'; message: string };

/** Window event the iOS app dispatches with a NativeSpeechEvent as `detail`. */
export const NATIVE_SPEECH_EVENT = 'quillspeech';

/**
 * The only URL scheme the login page will hand a credential to. Pinned so a
 * crafted /login link can't send a Google credential to another app's scheme.
 */
export const NATIVE_CALLBACK_SCHEME = 'quillai';

export function getQuillNative(): QuillNative | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { quillNative?: QuillNative }).quillNative ?? null;
}
