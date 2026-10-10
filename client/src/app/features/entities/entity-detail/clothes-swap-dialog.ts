import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { SourceThumbnailComponent } from './source-thumbnail';
import { ClothesSwapFormComponent, ClothesSwapResult } from './clothes-swap-form';

export {
  type ClothesSwapResult,
  MAX_SWAP_PROMPT_LENGTH,
  DEFAULT_SWAP_COUNT,
  MIN_SWAP_COUNT,
  MAX_SWAP_COUNT,
} from './clothes-swap-form';

export interface ClothesSwapDialogData {
  /** Thumbnail of the photo being edited, shown for confirmation. */
  thumbnailUrl: string;
  caption?: string;
  /** Overrides the line under the thumbnail — a captured video frame says so. */
  hint?: string;
}

/**
 * Collects the edit for a clothes swap of one gallery photo — what to change
 * about the clothing, pose or background — and how many versions to make. The
 * photo is already chosen; the person in it is kept.
 */
@Component({
  selector: 'app-clothes-swap-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, SourceThumbnailComponent, ClothesSwapFormComponent],
  template: `
    <h2 mat-dialog-title>Clothes swap</h2>
    <mat-dialog-content>
      <div class="still">
        <app-source-thumbnail [src]="data.thumbnailUrl" [alt]="data.caption || 'Photo to edit'" />
        <p class="still-hint">{{ data.hint || 'This person is kept. Describe the clothing, pose or background changes you want.' }}</p>
      </div>
      <app-clothes-swap-form />
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
export class ClothesSwapDialogComponent {
  readonly data = inject<ClothesSwapDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject<MatDialogRef<ClothesSwapDialogComponent, ClothesSwapResult>>(MatDialogRef);

  readonly form = viewChild.required(ClothesSwapFormComponent);

  confirm(): void {
    const result = this.form().result();
    if (result) this.dialogRef.close(result);
  }
}
