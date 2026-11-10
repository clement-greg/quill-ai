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
}

/**
 * The only URL scheme the login page will hand a credential to. Pinned so a
 * crafted /login link can't send a Google credential to another app's scheme.
 */
export const NATIVE_CALLBACK_SCHEME = 'quillai';

export function getQuillNative(): QuillNative | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { quillNative?: QuillNative }).quillNative ?? null;
}
