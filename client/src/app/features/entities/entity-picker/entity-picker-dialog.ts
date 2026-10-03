import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { EntityPick, EntityPickerComponent } from './entity-picker';

export interface EntityPickerDialogData {
  title?: string;
}

/** The entity picker on its own, for forms that only need the answer. */
@Component({
  selector: 'app-entity-picker-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, EntityPickerComponent],
  template: `
    <h2 mat-dialog-title>{{ data?.title || 'Choose an entity' }}</h2>
    <mat-dialog-content>
      <app-entity-picker [(selected)]="selected" />
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!selected()" (click)="confirm()">Select</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 90vw); box-sizing: border-box; }
  `],
})
export class EntityPickerDialogComponent {
  readonly data = inject<EntityPickerDialogData | null>(MAT_DIALOG_DATA, { optional: true });
  private dialogRef = inject<MatDialogRef<EntityPickerDialogComponent, EntityPick>>(MatDialogRef);

  readonly selected = signal<EntityPick | null>(null);

  confirm(): void {
    const pick = this.selected();
    if (pick) this.dialogRef.close(pick);
  }
}
