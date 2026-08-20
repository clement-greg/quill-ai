import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { TextFieldModule } from '@angular/cdk/text-field';

export interface VideoGenDialogData {
  /** Thumbnail of the still the video starts from, shown for confirmation. */
  thumbnailUrl: string;
  caption?: string;
}

export interface VideoGenResult {
  prompt: string;
}

/** The longest prompt the receiver is asked to take; it travels in a query string. */
export const MAX_VIDEO_PROMPT_LENGTH = 2000;

/**
 * Collects the motion prompt for an image-to-video job started from one gallery
 * photo. The photo itself is already chosen — this only asks what should happen
 * in the clip.
 */
@Component({
  selector: 'app-video-gen-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatInputModule,
    MatFormFieldModule,
    TextFieldModule,
  ],
  template: `
    <h2 mat-dialog-title>Generate video</h2>
    <mat-dialog-content>
      <div class="still">
        <img [src]="data.thumbnailUrl" [alt]="data.caption || 'Starting frame'" />
        <p class="still-hint">This photo is the first frame. Describe the motion you want.</p>
      </div>
      <mat-form-field appearance="outline" class="prompt-field">
        <mat-label>Motion prompt</mat-label>
        <textarea matInput
                  cdkTextareaAutosize
                  cdkAutosizeMinRows="4"
                  cdkAutosizeMaxRows="10"
                  [formControl]="prompt"
                  [maxlength]="MAX_PROMPT"
                  placeholder="e.g. slow push in, he turns and smiles, the flag ripples behind him"></textarea>
        <mat-hint align="end">{{ length() }} / {{ MAX_PROMPT }}</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="prompt.invalid" (click)="confirm()">Generate</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 90vw); box-sizing: border-box; }
    .still { display: flex; gap: 12px; align-items: center; margin: 4px 0 16px; }
    .still img { width: 88px; height: 88px; object-fit: cover; border-radius: 8px; flex: 0 0 auto; }
    .still-hint { margin: 0; font-size: 0.8rem; opacity: 0.75; }
    .prompt-field { width: 100%; }
  `],
})
export class VideoGenDialogComponent {
  readonly data = inject<VideoGenDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject<MatDialogRef<VideoGenDialogComponent, VideoGenResult>>(MatDialogRef);

  readonly MAX_PROMPT = MAX_VIDEO_PROMPT_LENGTH;

  // A prompt of only whitespace is no prompt, so the required check runs on the
  // trimmed value rather than on what is literally in the box.
  readonly prompt = new FormControl('', {
    nonNullable: true,
    validators: [c => (String(c.value).trim() ? null : { required: true }), Validators.maxLength(MAX_VIDEO_PROMPT_LENGTH)],
  });

  private readonly value = toSignal(this.prompt.valueChanges, { initialValue: '' });
  readonly length = () => this.value().length;

  confirm(): void {
    const prompt = this.prompt.value.trim();
    if (!prompt) return;
    this.dialogRef.close({ prompt });
  }
}
