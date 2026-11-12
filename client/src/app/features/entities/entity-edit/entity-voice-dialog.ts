import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Observable } from 'rxjs';
import { AzureVoice } from '@app/core/read-aloud/azure-speech-client';
import { VoiceGalleryComponent } from '@app/shared/voice-gallery/voice-gallery';

export interface EntityVoiceDialogData {
  name: string;
  voiceId: string | null;
  isNarrator: boolean;
}

/** The picked voice id, or null for the default; undefined when closed without picking. */
export type EntityVoiceDialogResult = { voiceId: string | null } | undefined;

/** Picks the Microsoft voice that reads a character's dialogue (or, for the narrator, the narration). */
@Component({
  selector: 'app-entity-voice-dialog',
  imports: [MatButtonModule, MatDialogModule, MatIconModule, VoiceGalleryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .evd-header { display: flex; align-items: center; justify-content: space-between; padding-right: 8px; }
    .evd-header h2 { margin: 0; }
    .evd-note { font-size: 13px; color: var(--mat-sys-on-surface-variant); max-width: 640px; margin: 0 0 12px; }
    .evd-default { margin-bottom: 16px; }
  `,
  template: `
    <div class="evd-header">
      <h2 mat-dialog-title>Voice for {{ data.name }}</h2>
      <button mat-icon-button mat-dialog-close type="button" aria-label="Close">
        <mat-icon>close</mat-icon>
      </button>
    </div>
    <mat-dialog-content>
      <p class="evd-note">
        @if (data.isNarrator) {
          Reads all narration when a book is read aloud. Without one, each reader's own voice choice is used.
        } @else {
          Reads {{ data.name }}'s dialogue and thoughts when a book is read aloud. Without one, the narration voice is used.
        }
        Press play to hear a voice; pick a card to use it.
      </p>
      <button mat-stroked-button type="button" class="evd-default" (click)="choose(null)"
        [attr.aria-pressed]="!data.voiceId">
        <mat-icon>{{ data.voiceId ? 'undo' : 'check_circle' }}</mat-icon>
        {{ data.isNarrator ? "Use the reader's voice" : 'Use the narration voice' }}
      </button>
      <app-voice-gallery mode="pick" [selectedId]="data.voiceId" (picked)="pick($event)" />
    </mat-dialog-content>
  `,
})
export class EntityVoiceDialogComponent {
  readonly data = inject<EntityVoiceDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<EntityVoiceDialogComponent, EntityVoiceDialogResult>);

  static open(dialog: MatDialog, data: EntityVoiceDialogData): Observable<EntityVoiceDialogResult> {
    return dialog.open<EntityVoiceDialogComponent, EntityVoiceDialogData, EntityVoiceDialogResult>(EntityVoiceDialogComponent, {
      data,
      width: '1100px',
      maxWidth: '96vw',
      maxHeight: '92vh',
      // Full screen on phones (styles.css).
      panelClass: 'vg-dialog-panel',
      autoFocus: 'first-tabbable',
      ariaLabel: `Voice for ${data.name}`,
    }).afterClosed();
  }

  pick(voice: AzureVoice): void {
    this.choose(voice.id);
  }

  choose(voiceId: string | null): void {
    this.ref.close({ voiceId });
  }
}
