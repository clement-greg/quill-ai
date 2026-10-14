/**
 * Bridge exposed by the Electron preload script (desktop/preload.js). Absent in
 * a normal browser, so its presence is how the client knows it is running in
 * the desktop app. Older installs may lack the newer members, so callers check
 * each one before use.
 */
export interface QuillDesktop {
  /** Runs Google Sign-In in the system browser and resolves with the Google ID token. */
  signInWithGoogle(): Promise<string>;
  /** Replaces the native menu bar's dynamic content. */
  setMenuModel?(model: DesktopMenuModel): void;
  /** Subscribes to native menu clicks; returns an unsubscribe function. */
  onMenuCommand?(listener: (command: DesktopMenuCommand) => void): () => void;
}

export interface DesktopMenuItem {
  id: string;
  label: string;
}

export interface DesktopLibraryChapter {
  id: string;
  title: string;
}

export interface DesktopLibraryBook {
  id: string;
  title: string;
  chapters: DesktopLibraryChapter[];
}

export interface DesktopLibrarySeries {
  id: string;
  title: string;
  books: DesktopLibraryBook[];
}

/** Everything the native menus show that depends on app state. */
export interface DesktopMenuModel {
  signedIn: boolean;
  /** Go menu entries, in explorer order. */
  navigation: DesktopMenuItem[];
  /** The current page's actions (the explorer's top section). */
  pageActions: DesktopMenuItem[];
  library: {
    loaded: boolean;
    series: DesktopLibrarySeries[];
  };
}

/** A native menu click, routed back to the client to carry out. */
export type DesktopMenuCommand =
  | { type: 'navigate'; id: string }
  | { type: 'page-action'; id: string }
  | { type: 'open'; kind: 'series' | 'book' | 'chapter'; id: string }
  | { type: 'home' }
  | { type: 'toggle-explorer' }
  | { type: 'refresh-library' }
  | { type: 'sign-out' };

export function getQuillDesktop(): QuillDesktop | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { quillDesktop?: QuillDesktop }).quillDesktop ?? null;
}
