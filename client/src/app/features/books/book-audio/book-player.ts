import {
  afterNextRender, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, Injector,
  signal, untracked, viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSliderModule } from '@angular/material/slider';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  chapterSpans, cumulativeSeconds, formatClock, formatDuration, nextChapterStart, segmentAtTime,
} from '@app/core/read-aloud/read-aloud-segments';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { ReadAloudSettingsComponent } from '@app/shared/read-aloud-player/read-aloud-settings';
import { BookService } from '@app/features/books/book.service';
import { SeriesService } from '@app/features/series/series.service';
import { firstValueFrom, forkJoin, of } from 'rxjs';
import { BookAudioService } from './book-audio.service';
import { buildLibrary, LibrarySeries } from './book-library';

/** How often the play head moves while playing. */
const TICK_MS = 500;

/** Full-screen "now playing" view for a book: artwork, a scrubber through the
 *  current chapter, transport controls, a chapter list to jump around, and a
 *  book picker (from the title) to switch to another book.
 *
 *  Speech engines only report when a paragraph starts, so time within a
 *  paragraph is measured here and capped at the paragraph's estimated length. */
@Component({
  selector: 'app-book-player',
  imports: [
    MatButtonModule, MatDialogModule, MatIconModule, MatProgressSpinnerModule, MatSliderModule, MatTooltipModule,
    ReadAloudSettingsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './book-player.html',
  styleUrl: './book-player.scss',
})
export class BookPlayerComponent {
  readonly ra = inject(ReadAloudService);
  readonly audio = inject(BookAudioService);

  private readonly seriesService = inject(SeriesService);
  private readonly bookService = inject(BookService);

  readonly showChapters = signal(false);
  private readonly chaptersToggle = viewChild.required('chaptersToggle', { read: ElementRef<HTMLElement> });

  readonly showBooks = signal(false);
  private readonly booksToggle = viewChild.required('booksToggle', { read: ElementRef<HTMLElement> });
  /** The reader's series and books, once fetched for the picker. */
  readonly library = signal<LibrarySeries[] | null>(null);
  readonly libraryFailed = signal(false);
  /** Series expanded in the picker. */
  readonly openSeries = signal<ReadonlySet<string>>(new Set());
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** Seconds into the chapter (at the current speed) while the scrubber is being dragged. */
  readonly scrubbing = signal<number | null>(null);

  /** Wall clock, refreshed while playing so the play head moves. */
  private readonly now = signal(Date.now());
  /** When the current paragraph started or resumed playing; null while it isn't. */
  private readonly segmentStartedAt = signal<number | null>(null);
  /** Milliseconds of the current paragraph played before the last pause. */
  private readonly segmentPlayedMs = signal(0);

  readonly playing = computed(() => this.ra.state() === 'playing');
  readonly chapters = computed(() => chapterSpans(this.ra.segments()));
  /** Estimated seconds before each segment at 1×; the last entry is the book's total. */
  private readonly times = computed(() => cumulativeSeconds(this.ra.segments()));
  readonly chapter = computed(() => {
    const index = this.ra.index();
    return this.chapters().find(c => index >= c.start && index < c.end) ?? null;
  });
  /** The playing chapter's picture, else the book's cover. */
  readonly artwork = computed(() => {
    const playing = this.audio.nowPlaying();
    const chapterId = this.chapter()?.chapterId;
    return (chapterId && playing?.chapterArt[chapterId]) || playing?.coverUrl || null;
  });
  readonly multiChapter = computed(() => this.chapters().length > 1);
  readonly hasNextChapter = computed(() => nextChapterStart(this.ra.segments(), this.ra.index()) >= 0);
  readonly atStart = computed(() => this.ra.index() === 0);
  readonly atEnd = computed(() => this.ra.index() >= this.ra.segments().length - 1);

  /** Estimated position in the queue, in seconds at 1×. */
  readonly position = computed(() => {
    const times = this.times();
    const index = this.ra.index();
    const segmentStart = times[index] ?? 0;
    const segmentLength = (times[index + 1] ?? segmentStart) - segmentStart;
    const started = this.segmentStartedAt();
    const playedMs = this.segmentPlayedMs() + (started === null ? 0 : Math.max(0, this.now() - started));
    return segmentStart + Math.min(segmentLength, (playedMs / 1000) * this.ra.rate());
  });
  /** The current chapter's estimated length in seconds at the current speed. */
  private readonly chapterSeconds = computed(() => {
    const c = this.chapter();
    const times = this.times();
    return c ? (times[c.end]! - times[c.start]!) / this.ra.rate() : 0;
  });
  /** Seconds into the chapter at the current speed. */
  private readonly chapterElapsed = computed(() => {
    const c = this.chapter();
    if (!c) return 0;
    return (this.position() - this.times()[c.start]!) / this.ra.rate();
  });

  /** Scrubber range: the current chapter, in seconds. */
  readonly scrubMax = computed(() => Math.max(1, Math.round(this.chapterSeconds())));
  readonly scrubValue = computed(() => this.scrubbing() ?? Math.min(this.scrubMax(), Math.round(this.chapterElapsed())));
  /** Elapsed / remaining in this chapter at the current speed. */
  readonly clock = computed(() => {
    const elapsed = this.scrubbing() ?? this.chapterElapsed();
    return { elapsed: formatClock(elapsed), remaining: formatClock(this.chapterSeconds() - elapsed) };
  });
  /** The paragraph the scrubber is over, so the reader knows where they'll land. */
  readonly scrubPreview = computed(() => {
    const seconds = this.scrubbing();
    if (seconds === null) return '';
    const index = this.segmentAt(seconds);
    return index === null ? '' : this.ra.segments()[index]?.text ?? '';
  });
  readonly bookProgress = computed(() => {
    const total = this.times().at(-1) ?? 0;
    if (!total) return null;
    const at = this.position();
    return {
      percent: Math.round((at / total) * 100),
      left: formatDuration((total - at) / this.ra.rate()),
    };
  });

  constructor() {
    // Time the current paragraph: restart on a new paragraph (or a speed
    // change, which replays it from the top); pause and resume the count.
    let last = { index: -1, rate: 0, playing: false };
    effect(() => {
      const index = this.ra.index();
      const rate = this.ra.rate();
      const playing = this.playing();
      untracked(() => {
        const now = Date.now();
        if (index !== last.index || rate !== last.rate) {
          this.segmentPlayedMs.set(0);
          this.segmentStartedAt.set(playing ? now : null);
        } else if (playing !== last.playing) {
          const started = this.segmentStartedAt();
          if (playing) this.segmentStartedAt.set(now);
          else {
            if (started !== null) this.segmentPlayedMs.update(ms => ms + now - started);
            this.segmentStartedAt.set(null);
          }
        }
        this.now.set(now);
        last = { index, rate, playing };
      });
    });
    const timer = setInterval(() => {
      if (this.segmentStartedAt() !== null) this.now.set(Date.now());
    }, TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  chapterLength(span: { start: number; end: number }): string {
    const times = this.times();
    return formatDuration((times[span.end]! - times[span.start]!) / this.ra.rate());
  }

  onScrub(value: number): void {
    this.scrubbing.set(value);
  }

  /** Jumps to the paragraph at that point; speech can only start at a paragraph. */
  commitScrub(value: number): void {
    this.scrubbing.set(null);
    const index = this.segmentAt(value);
    if (index !== null) this.ra.seek(index);
  }

  /** The current chapter's segment `seconds` in (at the current speed). */
  private segmentAt(seconds: number): number | null {
    const c = this.chapter();
    if (!c) return null;
    const times = this.times();
    return segmentAtTime(times, c.start, c.end, times[c.start]! + seconds * this.ra.rate());
  }

  /** Opens the chapter list on the playing chapter, or folds it away. */
  toggleChapters(): void {
    if (this.showChapters()) {
      this.showChapters.set(false);
      return;
    }
    this.showBooks.set(false);
    this.showChapters.set(true);
    this.focusInPanel('.bp-chapter.is-current');
  }

  /** Opens the book picker on the series being listened to, or folds it away. */
  toggleBooks(): void {
    if (this.showBooks()) {
      this.showBooks.set(false);
      return;
    }
    this.showChapters.set(false);
    this.showBooks.set(true);
    const seriesId = this.audio.nowPlaying()?.seriesId;
    if (seriesId) this.openSeries.update(open => new Set(open).add(seriesId));
    if (this.library()) this.focusInPanel('.bp-book.is-current', '.bp-series');
    void this.loadLibrary();
  }

  closeBooks(event?: Event): void {
    event?.stopPropagation(); // see closeChapters
    this.showBooks.set(false);
    this.booksToggle().nativeElement.focus();
  }

  toggleSeries(id: string): void {
    this.openSeries.update(open => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Switches to another book, picking it up where the reader left off. */
  async pickBook(bookId: string): Promise<void> {
    if (bookId === this.audio.nowPlaying()?.bookId) {
      this.closeBooks();
      return;
    }
    await this.audio.listen(bookId);
    if (this.audio.nowPlaying()?.bookId === bookId && this.showBooks()) this.closeBooks();
  }

  /** Where the reader is in a book, for its line in the picker. */
  bookStatus(bookId: string): string {
    if (bookId === this.audio.nowPlaying()?.bookId) {
      return `Now playing · ${this.bookProgress()?.percent ?? 0}%`;
    }
    const pos = this.audio.positionFor(bookId);
    if (!pos) return 'Not started';
    if (pos.finished) return 'Finished';
    return `${pos.chapterTitle} · ${Math.round(pos.progress * 100)}%`;
  }

  /** Fetches the reader's series and their books (fresh each time the picker opens). */
  private async loadLibrary(): Promise<void> {
    this.libraryFailed.set(false);
    try {
      const series = await firstValueFrom(this.seriesService.getAll());
      const books = await firstValueFrom(series.length
        ? forkJoin(series.map(s => this.bookService.getBySeries(s.id)))
        : of([]));
      const bySeries = new Map(series.map((s, i) => [s.id, books[i] ?? []]));
      const hadLibrary = this.library() !== null;
      this.library.set(buildLibrary(series, bySeries, this.audio.nowPlaying()?.seriesId));
      if (!hadLibrary && this.showBooks()) this.focusInPanel('.bp-book.is-current', '.bp-series');
    } catch {
      if (!this.library()) this.libraryFailed.set(true);
    }
  }

  /** After the panel renders, scrolls to and focuses the first selector that matches. */
  private focusInPanel(...selectors: string[]): void {
    afterNextRender(() => {
      const root = this.host.nativeElement;
      const target = selectors.map(sel => root.querySelector<HTMLElement>(sel)).find(Boolean);
      target?.scrollIntoView?.({ block: 'center' });
      target?.focus();
    }, { injector: this.injector });
  }

  /** Escape folds the list away instead of closing the whole player. */
  closeChapters(event?: Event): void {
    // The dialog closes on an Escape that reaches the page; keep this one here.
    event?.stopPropagation();
    this.showChapters.set(false);
    this.chaptersToggle().nativeElement.focus();
  }

  /** Jumps to a chapter and plays it. */
  playChapter(start: number): void {
    this.ra.seek(start);
    if (this.ra.state() !== 'playing') this.ra.playPause();
    this.closeChapters();
  }

  /** Read out as the slider's value text (mat-slider sets aria-valuetext from it). */
  readonly formatThumb = (value: number): string => `${formatClock(value)} of ${formatClock(this.scrubMax())}`;
}
