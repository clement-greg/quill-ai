import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';

/** Value the select uses for "System default" (a null voice id). */
const SYSTEM = '';

/** Settings page section: which voice the read-aloud player uses. */
@Component({
  selector: 'app-read-aloud-voice-settings',
  imports: [MatFormFieldModule, MatSelectModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .voice-field { width: 100%; max-width: 420px; }
    .voice-meta { color: var(--mat-sys-on-surface-variant); font-size: 12px; }
    .voice-note { font-size: 13px; color: var(--mat-sys-on-surface-variant); max-width: 560px; }
  `,
  template: `
    @if (!ra.supported) {
      <p class="voice-note">Read aloud isn't available in this browser.</p>
    } @else {
      <mat-form-field class="voice-field" appearance="outline">
        <mat-label>Voice</mat-label>
        <mat-select [value]="selected()" (selectionChange)="ra.setVoice($event.value || null)">
          @if (ra.azureVoices().length) {
            <mat-optgroup label="Microsoft voices">
              @for (voice of ra.azureVoices(); track voice.id) {
                <mat-option [value]="voice.id">
                  {{ voice.name }} <span class="voice-meta">{{ voice.lang }}</span>
                </mat-option>
              }
            </mat-optgroup>
          }
          <mat-optgroup label="Device voices">
            <mat-option [value]="system">System default</mat-option>
            @for (voice of ra.voices(); track voice.id) {
              <mat-option [value]="voice.id">
                {{ voice.name }} <span class="voice-meta">{{ voice.lang }}</span>
              </mat-option>
            }
          </mat-optgroup>
        </mat-select>
      </mat-form-field>
      <p class="voice-note">
        @if (ra.azureVoices().length) {
          Microsoft voices are natural-sounding neural voices spoken by Azure and need a connection.
          Device voices work offline.
        } @else {
          Uses the voices on this device.
        }
        @if (ra.engineKind === 'native') { The iPhone app remembers its own choice. }
      </p>
    }
  `,
})
export class ReadAloudVoiceSettingsComponent implements OnInit {
  readonly ra = inject(ReadAloudService);
  readonly system = SYSTEM;
  readonly selected = computed(() => this.ra.voiceId() ?? SYSTEM);

  ngOnInit(): void {
    void this.ra.loadVoices();
  }
}
