import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  chapterSpans, cumulativeSeconds, formatClock, formatDuration, nextChapterStart,
} from '@app/core/read-aloud/read-aloud-segments';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { ReadAloudSettingsComponent } from '@app/shared/read-aloud-player/read-aloud-settings';
import { BookAudioService } from './book-audio.service';

/** Full-screen "now playing" view for a book: artwork, a scrubber through the
 *  current chapter, transport controls and a chapter list to jump around. */
@Component({
  selector: 'app-book-player',
  imports: [MatButtonModule, MatDialogModule, MatIconModule, MatSliderModule, MatTooltipModule, ReadAloudSettingsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './book-player.html',
  styleUrl: './book-player.scss',
})
export class BookPlayerComponent {
  readonly ra = inject(ReadAloudService);
  readonly audio = inject(BookAudioService);

  readonly showChapters = signal(false);
  /** Paragraph offset within the chapter while the scrubber is being dragged. */
  readonly scrubbing = signal<number | null>(null);

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

  /** Scrubber range: the current chapter's segments. */
  readonly scrubMax = computed(() => {
    const c = this.chapter();
    return c ? Math.max(1, c.end - c.start - 1) : 1;
  });
  readonly scrubValue = computed(() => this.scrubbing() ?? this.ra.index() - (this.chapter()?.start ?? 0));
  /** Elapsed / remaining estimate in this chapter at the current speed. */
  readonly clock = computed(() => {
    const c = this.chapter();
    const times = this.times();
    if (!c) return { elapsed: '0:00', remaining: '0:00' };
    const rate = this.ra.rate();
    const at = times[c.start + this.scrubValue()] ?? 0;
    return {
      elapsed: formatClock((at - times[c.start]!) / rate),
      remaining: formatClock((times[c.end]! - at) / rate),
    };
  });
  /** The paragraph the scrubber is over, so the reader knows where they'll land. */
  readonly scrubPreview = computed(() => {
    const offset = this.scrubbing();
    const c = this.chapter();
    if (offset === null || !c) return '';
    return this.ra.segments()[c.start + offset]?.text ?? '';
  });
  readonly bookProgress = computed(() => {
    const times = this.times();
    const total = times.at(-1) ?? 0;
    if (!total) return null;
    const at = times[this.ra.index()] ?? 0;
    return {
      percent: Math.round((at / total) * 100),
      left: formatDuration((total - at) / this.ra.rate()),
    };
  });

  chapterLength(span: { start: number; end: number }): string {
    const times = this.times();
    return formatDuration((times[span.end]! - times[span.start]!) / this.ra.rate());
  }

  onScrub(value: number): void {
    this.scrubbing.set(value);
  }

  commitScrub(value: number): void {
    this.scrubbing.set(null);
    const c = this.chapter();
    if (c) this.ra.seek(c.start + value);
  }

  /** Jumps to a chapter and plays it. */
  playChapter(start: number): void {
    this.ra.seek(start);
    if (this.ra.state() !== 'playing') this.ra.playPause();
    this.showChapters.set(false);
  }

  /** Read out as the slider's value text (mat-slider sets aria-valuetext from it). */
  readonly formatThumb = (value: number): string => {
    const total = this.scrubMax() + 1;
    return value === 0 ? `Chapter title, 1 of ${total}` : `Paragraph ${value} of ${total - 1}`;
  };
}
