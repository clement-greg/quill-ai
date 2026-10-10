import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { SourceThumbnailComponent } from './source-thumbnail';
import { VideoGenFormComponent, VideoGenResult } from './video-gen-form';

export {
  type VideoGenResult,
  MAX_VIDEO_PROMPT_LENGTH,
  MIN_VIDEO_SECONDS,
  MAX_VIDEO_SECONDS,
  VIDEO_SECONDS_STEP,
  DEFAULT_VIDEO_SECONDS,
} from './video-gen-form';

export interface VideoGenDialogData {
  /** Thumbnail of the still the video starts from, shown for confirmation. */
  thumbnailUrl: string;
  caption?: string;
  /** Overrides the line under the thumbnail — a captured video frame says so. */
  hint?: string;
}

/**
 * Collects the motion prompt for an image-to-video job started from one gallery
 * photo. The photo itself is already chosen — this only asks what should happen
 * in the clip.
 */
@Component({
  selector: 'app-video-gen-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, SourceThumbnailComponent, VideoGenFormComponent],
  template: `
    <h2 mat-dialog-title>Generate video</h2>
    <mat-dialog-content>
      <div class="still">
        <app-source-thumbnail [src]="data.thumbnailUrl" [alt]="data.caption || 'Starting frame'" />
        <p class="still-hint">{{ data.hint || 'This photo is the first frame. Describe the motion you want.' }}</p>
      </div>
      <app-video-gen-form />
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="form().invalid()" (click)="confirm()">Generate</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 90vw); box-sizing: border-box; }
    .still { display: flex; gap: 12px; align-items: center; margin: 4px 0 16px; }
    .still-hint { margin: 0; font-size: 0.8rem; opacity: 0.75; }
  `],
})
export class VideoGenDialogComponent {
  readonly data = inject<VideoGenDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject<MatDialogRef<VideoGenDialogComponent, VideoGenResult>>(MatDialogRef);

  readonly form = viewChild.required(VideoGenFormComponent);

  confirm(): void {
    const result = this.form().result();
    if (result) this.dialogRef.close(result);
  }
}
