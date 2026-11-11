import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { isAzureVoice } from '@app/core/read-aloud/read-aloud.model';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { VoiceGalleryComponent } from '@app/shared/voice-gallery/voice-gallery';

/** Value the select uses for "System default" (a null voice id). */
const SYSTEM = '';

/** Settings page section: which voice the read-aloud player uses. */
@Component({
  selector: 'app-read-aloud-voice-settings',
  imports: [MatFormFieldModule, MatSelectModule, VoiceGalleryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .voice-current { font-size: 14px; margin: 0 0 16px; }
    .voice-current strong { font-weight: 600; }
    .voice-field { width: 100%; max-width: 420px; }
    .voice-meta { color: var(--mat-sys-on-surface-variant); font-size: 12px; }
    .voice-note { font-size: 13px; color: var(--mat-sys-on-surface-variant); max-width: 560px; }
    h4 { margin: 28px 0 4px; font-size: 15px; font-weight: 500; }
  `,
  template: `
    @if (!ra.supported) {
      <p class="voice-note">Read aloud isn't available in this browser.</p>
    } @else {
      <p class="voice-current">Reading with <strong>{{ currentName() }}</strong>.</p>

      @if (ra.azureCatalog().length) {
        <h4>Microsoft voices</h4>
        <p class="voice-note">
          Natural-sounding voices from Microsoft Azure. Press play to hear one, pick a card to use it, and pin
          favorites to keep them in the player's voice menu. They need a connection.
        </p>
        <app-voice-gallery />
        <h4>Device voices</h4>
        <p class="voice-note">Built into this device; they work offline.</p>
      }

      <mat-form-field class="voice-field" appearance="outline">
        <mat-label>Device voice</mat-label>
        <mat-select [value]="deviceSelection()" (selectionChange)="ra.setVoice($event.value || null)"
          [placeholder]="usingMicrosoft() ? 'Using a Microsoft voice' : ''">
          <mat-option [value]="system">System default</mat-option>
          @for (voice of ra.voices(); track voice.id) {
            <mat-option [value]="voice.id">
              {{ voice.name }} <span class="voice-meta">{{ voice.lang }}</span>
            </mat-option>
          }
        </mat-select>
      </mat-form-field>
      @if (ra.engineKind === 'native') {
        <p class="voice-note">The iPhone app remembers its own choice.</p>
      }
    }
  `,
})
export class ReadAloudVoiceSettingsComponent implements OnInit {
  readonly ra = inject(ReadAloudService);
  readonly system = SYSTEM;
  readonly usingMicrosoft = computed(() => isAzureVoice(this.ra.voiceId()));
  /** The device select shows nothing while a Microsoft voice is in use. */
  readonly deviceSelection = computed(() => this.usingMicrosoft() ? null : this.ra.voiceId() ?? SYSTEM);
  readonly currentName = computed(() => {
    const id = this.ra.voiceId();
    if (!id) return 'the system default voice';
    return [...this.ra.azureCatalog(), ...this.ra.voices()].find(v => v.id === id)?.name ?? id;
  });

  ngOnInit(): void {
    void this.ra.loadVoices();
  }
}
