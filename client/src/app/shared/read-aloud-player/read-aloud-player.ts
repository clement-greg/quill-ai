import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { nextChapterStart } from '@app/core/read-aloud/read-aloud-segments';
import { READ_ALOUD_RATES, ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { VoiceQuality } from '@app/core/read-aloud/read-aloud.model';

const QUALITY_LABEL: Record<VoiceQuality, string> = { premium: 'Premium', enhanced: 'Enhanced', default: '' };

/** Floating player bar shown while a chapter or book is being read aloud. */
@Component({
  selector: 'app-read-aloud-player',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './read-aloud-player.html',
  styleUrl: './read-aloud-player.scss',
})
export class ReadAloudPlayerComponent {
  readonly ra = inject(ReadAloudService);
  readonly rates = READ_ALOUD_RATES;
  readonly qualityLabel = QUALITY_LABEL;

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
  readonly selectedVoiceName = computed(() =>
    this.ra.voices().find(v => v.id === this.ra.voiceId())?.name ?? 'System default');
  readonly hasGoodVoice = computed(() => this.ra.voices().some(v => v.quality !== 'default'));
  /** Points the reader at free higher-quality voices for their platform. */
  readonly voiceHint = computed(() => {
    if (this.ra.engineKind === 'native') {
      return 'For more natural voices, download an Enhanced or Premium voice in Settings → Accessibility → Spoken Content → Voices.';
    }
    if (!this.hasGoodVoice()) return 'Microsoft Edge includes natural-sounding voices for free.';
    return '';
  });

  rateLabel(rate: number): string {
    return `${rate}×`;
  }
}
