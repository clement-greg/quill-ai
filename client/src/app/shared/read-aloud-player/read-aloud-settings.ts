import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { READ_ALOUD_RATES, ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { VoiceGalleryDialogComponent } from '@app/shared/voice-gallery/voice-gallery-dialog';

/** Speed menu and voice button (which opens the voice gallery), shared by the player bar and the full player. */
@Component({
  selector: 'app-read-aloud-settings',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ra-settings-group' },
  styles: `
    :host { display: contents; }
    .ra-rate { min-width: 48px; font-variant-numeric: tabular-nums; }
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

    <button mat-icon-button type="button" (click)="chooseVoice()" aria-haspopup="dialog"
      [attr.aria-label]="'Voice: ' + selectedVoiceName() + '. Change voice'" [matTooltip]="'Voice: ' + selectedVoiceName()">
      <mat-icon>record_voice_over</mat-icon>
    </button>
  `,
})
export class ReadAloudSettingsComponent {
  readonly ra = inject(ReadAloudService);
  private readonly dialog = inject(MatDialog);
  readonly rates = READ_ALOUD_RATES;

  readonly selectedVoiceName = computed(() => {
    const id = this.ra.voiceId();
    return [...this.ra.azureCatalog(), ...this.ra.voices()].find(v => v.id === id)?.name ?? 'System default';
  });

  constructor() {
    // So the button can name the voice in use.
    void this.ra.loadVoices();
  }

  chooseVoice(): void {
    VoiceGalleryDialogComponent.open(this.dialog);
  }

  rateLabel(rate: number): string {
    return `${rate}×`;
  }
}
