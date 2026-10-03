import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { PhotoGenFormComponent, PhotoGenResult } from './photo-gen-form';

export {
  type PhotoGenResult,
  MAX_IMAGE_PROMPT_LENGTH,
  DEFAULT_IMAGE_COUNT,
  MIN_IMAGE_COUNT,
  MAX_IMAGE_COUNT,
} from './photo-gen-form';

export interface PhotoGenDialogData {
  /** Thumbnail of the photo the face is taken from, shown for confirmation. */
  thumbnailUrl: string;
  caption?: string;
  /** Overrides the line under the thumbnail — a captured video frame says so. */
  hint?: string;
}

/**
 * Collects the prompt for a batch of stills generated from one gallery photo —
 * the face comes from the photo, everything else from the prompt. The photo is
 * already chosen; this only asks what the new images should show.
 */
@Component({
  selector: 'app-photo-gen-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, PhotoGenFormComponent],
  template: `
    <h2 mat-dialog-title>Generate images</h2>
    <mat-dialog-content>
      <div class="still">
        <img [src]="data.thumbnailUrl" [alt]="data.caption || 'Reference photo'" />
        <p class="still-hint">{{ data.hint || "This photo's face is kept. Describe the images you want." }}</p>
      </div>
      <app-photo-gen-form />
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="form().invalid()" (click)="confirm()">Generate</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 90vw); box-sizing: border-box; }
    .still { display: flex; gap: 12px; align-items: center; margin: 4px 0 16px; }
    .still img { width: 88px; height: 88px; object-fit: cover; border-radius: 8px; flex: 0 0 auto; }
    .still-hint { margin: 0; font-size: 0.8rem; opacity: 0.75; }
  `],
})
export class PhotoGenDialogComponent {
  readonly data = inject<PhotoGenDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject<MatDialogRef<PhotoGenDialogComponent, PhotoGenResult>>(MatDialogRef);

  readonly form = viewChild.required(PhotoGenFormComponent);

  confirm(): void {
    const result = this.form().result();
    if (result) this.dialogRef.close(result);
  }
}
