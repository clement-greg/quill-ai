import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { ReadAloudChapter } from '@app/core/read-aloud/read-aloud.model';
import { BookService } from '@app/features/books/book.service';
import { ChapterService } from '@app/features/chapters/chapter.service';
import { ChapterDraftService } from '@app/features/chapters/chapter-edit/chapter-draft.service';
import { ListeningPosition, ListeningPositionUpdate } from '@shared/models/listening.model';
import { BookPlayerComponent } from './book-player';

/** How often a position is sent to the server while playing. Pausing,
 *  stopping or leaving the page sends it straight away. */
export const SAVE_INTERVAL_MS = 10_000;

/** What's loaded in the player, for its header and artwork. */
export interface NowPlaying {
  bookId: string;
  title: string;
  /** Proxied cover image URL, ready for an <img>. */
  coverUrl: string | null;
}

/** Book listening: starts a book where the reader left off, remembers the
 *  position (synced through the server, so it follows them between devices),
 *  and opens the full player. */
@Injectable({ providedIn: 'root' })
export class BookAudioService {
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  private readonly ra = inject(ReadAloudService);
  private readonly books = inject(BookService);
  private readonly chapters = inject(ChapterService);
  private readonly drafts = inject(ChapterDraftService);
  private readonly doc = inject(DOCUMENT);

  readonly supported = this.ra.supported;
  /** Remembered positions, most recently played first. */
  readonly positions = signal<ListeningPosition[]>([]);
  /** The book to offer "Resume listening" for. */
  readonly resumable = computed(() => this.positions().find(p => !p.finished) ?? null);
  /** Book id while it's being fetched for playback. */
  readonly loading = signal<string | null>(null);
  /** Why the last listen() failed, for that book's page. */
  readonly error = signal<{ bookId: string; message: string } | null>(null);
  readonly nowPlaying = signal<NowPlaying | null>(null);
  /** The full player is open (the floating bar hides meanwhile). */
  readonly expanded = signal(false);

  private playerRef: MatDialogRef<unknown> | null = null;
  private pending: { bookId: string; update: ListeningPositionUpdate } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private positionsLoaded: Promise<void> | null = null;
  /** The playing book's cover as stored, saved with its position. */
  private coverUrl: string | undefined;

  constructor() {
    effect(() => {
      const bookId = this.ra.bookId();
      const current = this.ra.current();
      const finished = this.ra.finished();
      const playing = this.ra.state() === 'playing';
      untracked(() => this.track(bookId, finished, playing, current !== null));
    });
    const flush = () => this.flush();
    this.doc.defaultView?.addEventListener('pagehide', flush);
    this.doc.addEventListener('visibilitychange', () => {
      if (this.doc.visibilityState === 'hidden') flush();
    });
  }

  /** Fetches remembered positions (once; pass force to refresh). */
  loadPositions(force = false): Promise<void> {
    if (!this.positionsLoaded || force) {
      this.positionsLoaded = firstValueFrom(this.http.get<ListeningPosition[]>('/api/listening'))
        .then(list => this.positions.set(list))
        .catch(() => { this.positionsLoaded = null; });
    }
    return this.positionsLoaded;
  }

  positionFor(bookId: string): ListeningPosition | null {
    return this.positions().find(p => p.bookId === bookId) ?? null;
  }

  /** Is this book the one loaded in the player? */
  isLoaded(bookId: string): boolean {
    return this.ra.active() && this.ra.bookId() === bookId;
  }

  /**
   * Plays a book from where the reader left off (or the beginning, the first
   * time, after finishing it, or with fromStart) and opens the player. Call
   * straight from a click: browsers only let a user gesture start speech.
   */
  async listen(bookId: string, options: { fromStart?: boolean } = {}): Promise<void> {
    if (!this.ra.supported) return;
    if (this.isLoaded(bookId) && !options.fromStart) {
      if (this.ra.state() !== 'playing') this.ra.playPause();
      this.open();
      return;
    }
    this.ra.prime();
    this.loading.set(bookId);
    this.error.set(null);
    try {
      const [book, chapters, saved] = await Promise.all([
        firstValueFrom(this.books.getById(bookId)),
        this.loadChapters(bookId),
        this.loadPositions().then(() => this.positionFor(bookId)),
      ]);
      if (this.loading() !== bookId) return; // another book was picked meanwhile
      if (!chapters.length) {
        this.error.set({ bookId, message: 'This book has no chapters to read yet.' });
        return;
      }
      const resume = saved && !saved.finished && !options.fromStart ? saved : null;
      this.flush();
      this.nowPlaying.set({ bookId, title: book.title, coverUrl: proxyImageUrl(book.originalUrl ?? book.thumnailUrl) });
      this.coverUrl = book.thumnailUrl ?? book.originalUrl;
      this.ra.start(chapters, {
        bookTitle: book.title,
        bookId,
        chapterId: resume?.chapterId,
        blockIndex: resume?.blockIndex ?? null,
      });
      if (this.ra.active()) this.open();
      else this.error.set({ bookId, message: 'This book has nothing to read yet.' });
    } catch {
      this.error.set({ bookId, message: 'Couldn’t load the book. Try again.' });
    } finally {
      if (this.loading() === bookId) this.loading.set(null);
    }
  }

  /** Opens the full player for what's loaded. */
  open(): void {
    if (this.playerRef || !this.ra.active()) return;
    this.playerRef = this.dialog.open(BookPlayerComponent, {
      panelClass: 'book-player-dialog',
      width: '520px',
      maxWidth: '100vw',
      autoFocus: 'dialog',
      ariaLabel: 'Book player',
    });
    this.expanded.set(true);
    this.playerRef.afterClosed().subscribe(() => {
      this.playerRef = null;
      this.expanded.set(false);
    });
  }

  /** Shrinks the player back to the floating bar; playback continues. */
  minimize(): void {
    this.playerRef?.close();
  }

  /** Stops playback and closes the player. */
  stop(): void {
    this.minimize();
    this.ra.stop();
  }

  /** Every chapter in reading order, with unsaved drafts from this device. */
  private async loadChapters(bookId: string): Promise<ReadAloudChapter[]> {
    const list = await firstValueFrom(this.chapters.getByBook(bookId));
    const sorted = list
      .filter(c => !c.archived)
      .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    return Promise.all(sorted.map(async c => {
      const draft = await this.drafts.resolvePendingDraft(c).catch(() => null);
      return { id: c.id, title: c.title, html: draft?.content ?? c.content ?? '' };
    }));
  }

  /** Notes the current position; sends it now if playback paused, stopped or
   *  finished, else at most every SAVE_INTERVAL_MS. */
  private track(bookId: string | null, finished: boolean, playing: boolean, hasCurrent: boolean): void {
    if (!bookId || !hasCurrent) {
      if (!bookId) {
        this.nowPlaying.set(null);
        this.minimize();
      }
      this.flush();
      return;
    }
    const update = this.positionUpdate(finished);
    if (!update) return;
    this.pending = { bookId, update };
    this.positions.update(list => [
      { ...update, bookId, updatedAt: Date.now() },
      ...list.filter(p => p.bookId !== bookId),
    ]);
    if (!playing || finished) this.flush();
    else this.saveTimer ??= setTimeout(() => this.flush(), SAVE_INTERVAL_MS);
  }

  private positionUpdate(finished: boolean): ListeningPositionUpdate | null {
    const segments = this.ra.segments();
    const current = this.ra.current();
    if (!current) return null;
    const index = this.ra.index();
    const before = segments.slice(0, index).reduce((n, s) => n + s.text.length, 0);
    const total = segments.reduce((n, s) => n + s.text.length, 0) || 1;
    return {
      bookTitle: this.nowPlaying()?.title ?? '',
      chapterId: current.chapterId,
      chapterTitle: current.chapterTitle,
      blockIndex: current.blockIndex,
      progress: finished ? 1 : before / total,
      ...(this.coverUrl ? { coverUrl: this.coverUrl } : {}),
      ...(finished ? { finished: true } : {}),
    };
  }

  private flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.http.put(`/api/listening/${encodeURIComponent(pending.bookId)}`, pending.update)
      .subscribe({ error: () => { /* best effort; the next save catches up */ } });
  }
}

/** Book images are served through the app's image proxy. */
export function proxyImageUrl(blobUrl: string | undefined): string | null {
  const filename = blobUrl?.split('/').pop();
  return filename ? `/api/image/${filename}` : null;
}
