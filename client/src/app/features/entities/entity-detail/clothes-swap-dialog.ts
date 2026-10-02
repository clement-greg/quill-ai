import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSliderModule } from '@angular/material/slider';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TextFieldModule } from '@angular/cdk/text-field';

export interface ClothesSwapDialogData {
  /** Thumbnail of the photo being edited, shown for confirmation. */
  thumbnailUrl: string;
  caption?: string;
  /** Overrides the line under the thumbnail — a captured video frame says so. */
  hint?: string;
}

export interface ClothesSwapResult {
  prompt: string;
  /** Edited copies to generate in this run. */
  count: number;
  /** Paste the original face back over each edit. */
  restoreFace: boolean;
}

/** The longest prompt the receiver is asked to take; it travels in a query string. */
export const MAX_SWAP_PROMPT_LENGTH = 2000;

/** Edits per run. The server's ceiling is 8 — each is a full pass on one GPU. */
export const DEFAULT_SWAP_COUNT = 1;
export const MIN_SWAP_COUNT = 1;
export const MAX_SWAP_COUNT = 8;

/**
 * Collects the edit for a clothes swap of one gallery photo — what to change
 * about the clothing, pose or background — and how many versions to make. The
 * photo is already chosen; the person in it is kept.
 */
@Component({
  selector: 'app-clothes-swap-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatInputModule,
    MatFormFieldModule,
    MatSliderModule,
    MatSlideToggleModule,
    TextFieldModule,
  ],
  template: `
    <h2 mat-dialog-title>Clothes swap</h2>
    <mat-dialog-content>
      <div class="still">
        <img [src]="data.thumbnailUrl" [alt]="data.caption || 'Photo to edit'" />
        <p class="still-hint">{{ data.hint || 'This person is kept. Describe the clothing, pose or background changes you want.' }}</p>
      </div>
      <mat-form-field appearance="outline" class="prompt-field">
        <mat-label>Changes</mat-label>
        <textarea matInput
                  cdkTextareaAutosize
                  cdkAutosizeMinRows="4"
                  cdkAutosizeMaxRows="10"
                  [formControl]="prompt"
                  [maxlength]="MAX_PROMPT"
                  placeholder="e.g. Change the clothing to a charcoal wool overcoat over a white shirt. Replace the background with a city street at dusk."></textarea>
        <mat-hint align="end">{{ length() }} / {{ MAX_PROMPT }}</mat-hint>
      </mat-form-field>

      <div class="count">
        <label class="count-label" for="swap-count">
          Images <span class="count-value">{{ chosenCount() }}</span>
        </label>
        <mat-slider [min]="MIN_COUNT" [max]="MAX_COUNT" step="1" discrete>
          <input matSliderThumb id="swap-count" [formControl]="count"
                 aria-label="Number of images to generate" />
        </mat-slider>
      </div>

      <div class="face">
        <mat-slide-toggle [formControl]="restoreFace">Paste original face back</mat-slide-toggle>
        <p class="face-hint">
          Lays the photo's own face over each result. Only for clothing or background
          changes — with a new pose the face moves, and the paste is left floating
          where the head used to be.
        </p>
      </div>
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
    .count { display: flex; flex-direction: column; }
    .count-label { font-size: 0.85rem; }
    .count-value { font-weight: 500; }
    mat-slider { width: 100%; }
    .face { margin-top: 8px; }
    .face-hint { margin: 4px 0 0; font-size: 0.8rem; opacity: 0.75; }
  `],
})
export class ClothesSwapDialogComponent {
  readonly data = inject<ClothesSwapDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject<MatDialogRef<ClothesSwapDialogComponent, ClothesSwapResult>>(MatDialogRef);

  readonly MAX_PROMPT = MAX_SWAP_PROMPT_LENGTH;
  readonly MIN_COUNT = MIN_SWAP_COUNT;
  readonly MAX_COUNT = MAX_SWAP_COUNT;

  // Whitespace alone is no instruction, so the required check runs on the
  // trimmed value rather than on what is literally in the box.
  readonly prompt = new FormControl('', {
    nonNullable: true,
    validators: [c => (String(c.value).trim() ? null : { required: true }), Validators.maxLength(MAX_SWAP_PROMPT_LENGTH)],
  });

  readonly count = new FormControl(DEFAULT_SWAP_COUNT, { nonNullable: true });
  readonly restoreFace = new FormControl(false, { nonNullable: true });

  private readonly value = toSignal(this.prompt.valueChanges, { initialValue: '' });
  readonly length = () => this.value().length;

  readonly chosenCount = toSignal(this.count.valueChanges, { initialValue: DEFAULT_SWAP_COUNT });

  confirm(): void {
    const prompt = this.prompt.value.trim();
    if (!prompt) return;
    this.dialogRef.close({
      prompt,
      count: this.count.value,
      restoreFace: this.restoreFace.value,
    });
  }
}
