import { Component, ChangeDetectionStrategy, inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TextDiffViewComponent } from '@app/shared/text-diff-view/text-diff-view';

export interface DraftDiffDialogData {
  /** Content of the chapter as it exists on the server. */
  savedContent: string;
  /** Content of the cached, unsaved draft. */
  draftContent: string;
}

@Component({
  selector: 'app-draft-diff-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, TextDiffViewComponent],
  template: `
    <h2 mat-dialog-title>Unsaved draft changes</h2>
    <mat-dialog-content class="dialog-content">
      <app-text-diff-view
        [oldText]="data.savedContent"
        [newText]="data.draftContent"
        oldLabel="Last saved"
        newLabel="Unsaved draft" />
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Close</button>
    </mat-dialog-actions>
  `,
  styles: `
    .dialog-content {
      height: min(70vh, 560px);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      padding: 0;
    }
  `,
})
export class DraftDiffDialogComponent {
  readonly data: DraftDiffDialogData = inject(MAT_DIALOG_DATA);
}
