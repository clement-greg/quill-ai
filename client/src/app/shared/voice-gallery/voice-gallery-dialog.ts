import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { VoicePickerComponent } from './voice-picker';

/** The voice picker (gallery plus device voices) in a dialog, opened from the player's voice button. */
@Component({
  selector: 'app-voice-gallery-dialog',
  imports: [MatButtonModule, MatDialogModule, MatIconModule, VoicePickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .vgd-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-right: 8px;
    }
    .vgd-header h2 { margin: 0; }
  `,
  template: `
    <div class="vgd-header">
      <h2 mat-dialog-title>Choose a voice</h2>
      <button mat-icon-button mat-dialog-close type="button" aria-label="Close">
        <mat-icon>close</mat-icon>
      </button>
    </div>
    <mat-dialog-content>
      <app-voice-picker />
    </mat-dialog-content>
  `,
})
export class VoiceGalleryDialogComponent {
  static open(dialog: MatDialog): void {
    dialog.open(VoiceGalleryDialogComponent, {
      width: '1100px',
      maxWidth: '96vw',
      maxHeight: '92vh',
      // Full screen on phones (styles.css).
      panelClass: 'vg-dialog-panel',
      autoFocus: 'first-tabbable',
      ariaLabel: 'Choose a voice',
    });
  }
}
