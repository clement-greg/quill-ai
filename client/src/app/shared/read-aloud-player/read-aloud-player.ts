import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { nextChapterStart } from '@app/core/read-aloud/read-aloud-segments';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { BookAudioService } from '@app/features/books/book-audio/book-audio.service';
import { ReadAloudSettingsComponent } from './read-aloud-settings';

/** Floating player bar shown while a book is being read aloud (hidden while
 *  the full player is open). */
@Component({
  selector: 'app-read-aloud-player',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, ReadAloudSettingsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './read-aloud-player.html',
  styleUrl: './read-aloud-player.scss',
})
export class ReadAloudPlayerComponent {
  readonly ra = inject(ReadAloudService);
  readonly audio = inject(BookAudioService);

  readonly playing = computed(() => this.ra.state() === 'playing');
  readonly multiChapter = computed(() => this.ra.chapterCount() > 1);
  readonly hasNextChapter = computed(() => nextChapterStart(this.ra.segments(), this.ra.index()) >= 0);
  readonly atStart = computed(() => this.ra.index() === 0);
  readonly atEnd = computed(() => this.ra.index() >= this.ra.segments().length - 1);
  readonly title = computed(() => this.ra.current()?.chapterTitle ?? '');
  readonly subtitle = computed(() => {
    const cur = this.ra.current();
    const progress = this.ra.chapterProgress();
    if (!cur || !progress) return '';
    const chapter = this.multiChapter() ? `Chapter ${cur.chapterIndex + 1} of ${this.ra.chapterCount()} · ` : '';
    const where = cur.blockIndex < 0 ? 'Title' : `Paragraph ${progress.paragraph} of ${progress.total}`;
    return chapter + where;
  });
}
