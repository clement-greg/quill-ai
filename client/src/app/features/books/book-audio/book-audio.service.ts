import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { PLAYHEAD_TEXT_MAX, ReadAloudCast, ReadAloudChapter } from '@app/core/read-aloud/read-aloud.model';
import { EntityService } from '@app/features/entities/entity.service';
import { BookService } from '@app/features/books/book.service';
import { ChapterService } from '@app/features/chapters/chapter.service';
import { ChapterDraftService } from '@app/features/chapters/chapter-edit/chapter-draft.service';
import { Book } from '@shared/models/book.model';
import { ListeningPosition, ListeningPositionUpdate } from '@shared/models/listening.model';
import { BookPlayerComponent } from './book-player';
import { proxyImageUrl } from '@app/core/utils/image-proxy';

/** How often a position is sent to the server while playing. Pausing,
 *  stopping or leaving the page sends it straight away. */
export const SAVE_INTERVAL_MS = 10_000;

/** What's loaded in the player, for its header and artwork. */
export interface NowPlaying {
  bookId: string;
  seriesId: string;
  title: string;
  /** Proxied cover image URL, ready for an <img>. */
  coverUrl: string | null;
  /** Proxied image per chapter id, for chapters that have one. */
  chapterArt: Readonly<Record<string, string>>;
}

/** A book's chapters ready to play, plus their pictures. */
interface LoadedChapters {
  chapters: ReadAloudChapter[];
  art: Record<string, string>;
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
  private readonly entities = inject(EntityService);
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
  /** Settles once a book the iPhone app was already reading has been taken over. */
  private readonly adopted: Promise<void>;

  constructor() {
    effect(() => {
      const bookId = this.ra.bookId();
      const current = this.ra.current();
      const finished = this.ra.finished();
      const playing = this.ra.state() === 'playing';
      untracked(() => this.track(bookId, finished, playing, current !== null));
    });
    this.adopted = this.adoptRunningBook();
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
    // The iPhone app may still be reading this book from before the page
    // reloaded: carry on from exactly there instead of the saved position.
    // (Only the app's engine waits; a browser needs play() inside the click.)
    if (this.ra.engineKind === 'native') await this.adopted;
    if (this.isLoaded(bookId) && !options.fromStart) {
      if (this.ra.state() !== 'playing') this.ra.playPause();
      this.open();
      return;
    }
    this.ra.prime();
    this.loading.set(bookId);
    this.error.set(null);
    try {
      const [{ book, cast }, { chapters, art }, saved] = await Promise.all([
        this.loadBook(bookId),
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
      this.showNowPlaying(bookId, book, art);
      this.ra.start(chapters, {
        bookTitle: book.title,
        bookId,
        chapterId: resume?.chapterId,
        blockIndex: resume?.blockIndex ?? null,
        cast,
      });
      if (this.ra.active()) this.open();
      else this.error.set({ bookId, message: 'This book has nothing to read yet.' });
    } catch {
      this.error.set({ bookId, message: 'Couldn’t load the book. Try again.' });
    } finally {
      if (this.loading() === bookId) this.loading.set(null);
    }
  }

  /**
   * When the page (re)loads while the iPhone app is still reading a book —
   * the web view can be reloaded under it in the background — shows that book
   * as playing, at the app's exact place, rather than nothing.
   */
  private async adoptRunningBook(): Promise<void> {
    try {
      const status = await this.ra.engineStatus();
      if (!status?.bookId || status.state === 'idle' || this.ra.active()) return;
      const bookId = status.bookId;
      const [{ book, cast }, { chapters, art }] = await Promise.all([
        this.loadBook(bookId),
        this.loadChapters(bookId),
      ]);
      if (this.ra.active()) return; // something else started meanwhile
      if (this.ra.attach(chapters, { bookTitle: book.title, bookId, cast }, status)) this.showNowPlaying(bookId, book, art);
    } catch {
      // Nothing to take over; listen() starts from the saved position.
    }
  }

  private showNowPlaying(bookId: string, book: Book, art: Record<string, string>): void {
    this.nowPlaying.set({
      bookId,
      seriesId: book.seriesId,
      title: book.title,
      coverUrl: proxyImageUrl(book.originalUrl ?? book.thumnailUrl),
      chapterArt: art,
    });
    this.coverUrl = book.thumnailUrl ?? book.originalUrl;
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

  /** The book and its series' character voices. */
  private async loadBook(bookId: string): Promise<{ book: Book; cast: ReadAloudCast | null }> {
    const book = await firstValueFrom(this.books.getById(bookId));
    return { book, cast: await this.loadCast(book.seriesId) };
  }

  /** Voices assigned to the series' characters and narrator; null when none are
   *  (or they can't be loaded — the book still plays, all in the reader's voice). */
  private async loadCast(seriesId: string | undefined): Promise<ReadAloudCast | null> {
    if (!seriesId) return null;
    try {
      const list = await firstValueFrom(this.entities.getBySeries(seriesId));
      const voices: Record<string, string> = {};
      let narratorVoiceId: string | null = null;
      for (const e of list) {
        if (!e.voiceId || e.type !== 'PERSON' || e.archived || e.deleted) continue;
        voices[e.id] = e.voiceId;
        if (e.isNarrator) narratorVoiceId = e.voiceId;
      }
      return Object.keys(voices).length ? { narratorVoiceId, voices } : null;
    } catch {
      return null;
    }
  }

  /** Every chapter in reading order, with unsaved drafts from this device,
   *  and each chapter's picture where it has one. */
  private async loadChapters(bookId: string): Promise<LoadedChapters> {
    const list = await firstValueFrom(this.chapters.getByBook(bookId));
    const sorted = list
      .filter(c => !c.archived)
      .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    const chapters = await Promise.all(sorted.map(async c => {
      const draft = await this.drafts.resolvePendingDraft(c).catch(() => null);
      return { id: c.id, title: c.title, html: draft?.content ?? c.content ?? '', dialogue: c.dialogue };
    }));
    const art: Record<string, string> = {};
    for (const c of sorted) {
      const url = proxyImageUrl(c.imageUrl || c.imageThumbnailUrl);
      if (url) art[c.id] = url;
    }
    return { chapters, art };
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
      // Lets a note added by voice find the paragraph being read.
      ...(current.blockIndex >= 0 ? { blockText: current.text.slice(0, PLAYHEAD_TEXT_MAX) } : {}),
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

export { proxyImageUrl } from '@app/core/utils/image-proxy';
