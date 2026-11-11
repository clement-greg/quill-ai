import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { VoiceGalleryDialogComponent } from '@app/shared/voice-gallery/voice-gallery-dialog';
import { READ_ALOUD_RATES, ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { VoiceQuality } from '@app/core/read-aloud/read-aloud.model';

const QUALITY_LABEL: Record<VoiceQuality, string> = { premium: 'Premium', enhanced: 'Enhanced', default: '' };

/** Speed and voice pickers, shared by the player bar and the full player. */
@Component({
  selector: 'app-read-aloud-settings',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ra-settings-group' },
  styles: `
    :host { display: contents; }
    .ra-rate { min-width: 48px; font-variant-numeric: tabular-nums; }
    .ra-voice-meta {
      margin-left: 8px;
      font-size: 12px;
      color: var(--mat-sys-on-surface-variant);
    }
    .ra-voice-group-label {
      padding: 8px 16px 4px;
      font-size: 12px;
      font-weight: 500;
      color: var(--mat-sys-on-surface-variant);
    }
    .ra-voice-hint {
      margin: 4px 16px 8px;
      max-width: 280px;
      font-size: 12px;
      line-height: 1.4;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
  template: `
    <button mat-button type="button" class="ra-rate" [matMenuTriggerFor]="rateMenu"
      [attr.aria-label]="'Speed ' + rateLabel(ra.rate())" matTooltip="Speed">
      {{ rateLabel(ra.rate()) }}
    </button>
    <mat-menu #rateMenu="matMenu">
      @for (rate of rates; track rate) {
        <button mat-menu-item type="button" (click)="ra.setRate(rate)" [attr.aria-checked]="rate === ra.rate()" role="menuitemradio">
          <mat-icon>{{ rate === ra.rate() ? 'check' : '' }}</mat-icon>
          {{ rateLabel(rate) }}
        </button>
      }
    </mat-menu>

    <button mat-icon-button type="button" [matMenuTriggerFor]="voiceMenu" (menuOpened)="ra.loadVoices()"
      [attr.aria-label]="'Voice: ' + selectedVoiceName()" [matTooltip]="'Voice: ' + selectedVoiceName()">
      <mat-icon>record_voice_over</mat-icon>
    </button>
    <mat-menu #voiceMenu="matMenu" class="ra-voice-menu">
      @if (ra.azureCatalog().length) {
        <div role="group" aria-label="Microsoft voices">
          <div class="ra-voice-group-label" aria-hidden="true">Microsoft voices</div>
          @for (voice of quickVoices(); track voice.id) {
            <button mat-menu-item type="button" (click)="ra.setVoice(voice.id)" role="menuitemradio"
              [attr.aria-checked]="voice.id === ra.voiceId()">
              <mat-icon>{{ voice.id === ra.voiceId() ? 'check' : '' }}</mat-icon>
              <span>{{ voice.name }}</span>
              <span class="ra-voice-meta">{{ voice.lang }}@if (isPinned(voice.id)) { · Pinned}</span>
            </button>
          }
          <button mat-menu-item type="button" (click)="browse()">
            <mat-icon>library_music</mat-icon>
            Browse all voices…
          </button>
        </div>
      }
      <div role="group" aria-label="Device voices">
        @if (ra.azureCatalog().length) {
          <div class="ra-voice-group-label" aria-hidden="true">Device voices</div>
        }
        <button mat-menu-item type="button" (click)="ra.setVoice(null)" role="menuitemradio" [attr.aria-checked]="!ra.voiceId()">
          <mat-icon>{{ !ra.voiceId() ? 'check' : '' }}</mat-icon>
          System default
        </button>
        @for (voice of ra.voices(); track voice.id) {
          <button mat-menu-item type="button" (click)="ra.setVoice(voice.id)" role="menuitemradio"
            [attr.aria-checked]="voice.id === ra.voiceId()">
            <mat-icon>{{ voice.id === ra.voiceId() ? 'check' : '' }}</mat-icon>
            <span>{{ voice.name }}</span>
            <span class="ra-voice-meta">{{ voice.lang }}@if (qualityLabel[voice.quality]) { · {{ qualityLabel[voice.quality] }}}</span>
          </button>
        }
      </div>
      @if (voiceHint()) {
        <p class="ra-voice-hint">{{ voiceHint() }}</p>
      }
    </mat-menu>
  `,
})
export class ReadAloudSettingsComponent {
  readonly ra = inject(ReadAloudService);
  private readonly dialog = inject(MatDialog);
  readonly rates = READ_ALOUD_RATES;

  /** The Microsoft voices worth listing in a menu: pinned ones, the current one and the default. */
  readonly quickVoices = computed(() => {
    const catalog = this.ra.azureCatalog();
    const ids = [...this.ra.pinnedVoices(), this.ra.voiceId(), this.ra.azureDefaultId()];
    const seen = new Set<string>();
    return ids.flatMap(id => {
      if (!id || seen.has(id)) return [];
      seen.add(id);
      const voice = catalog.find(v => v.id === id);
      return voice ? [voice] : [];
    });
  });
  readonly qualityLabel = QUALITY_LABEL;

  readonly selectedVoiceName = computed(() => {
    const id = this.ra.voiceId();
    return [...this.ra.azureCatalog(), ...this.ra.voices()].find(v => v.id === id)?.name ?? 'System default';
  });
  readonly hasGoodVoice = computed(() =>
    this.ra.azureCatalog().length > 0 || this.ra.voices().some(v => v.quality !== 'default'));
  /** Points the reader at free higher-quality voices for their platform. */
  readonly voiceHint = computed(() => {
    if (this.ra.engineKind === 'native') {
      return 'For more natural voices, download an Enhanced or Premium voice in Settings → Accessibility → Spoken Content → Voices.';
    }
    if (!this.hasGoodVoice()) return 'Microsoft Edge includes natural-sounding voices for free.';
    return '';
  });

  isPinned(id: string): boolean {
    return this.ra.pinnedVoices().includes(id);
  }

  browse(): void {
    VoiceGalleryDialogComponent.open(this.dialog);
  }

  rateLabel(rate: number): string {
    return `${rate}×`;
  }
}
