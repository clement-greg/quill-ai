import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TaskFulfillmentCandidate } from '@shared/models/task.model';

export interface TaskFulfillmentDialogData {
  candidates: TaskFulfillmentCandidate[];
}

/** Ids of the tasks the author chose to complete; [] (or undefined on dismiss) for none. */
export type TaskFulfillmentDialogResult = string[];

/** After a chapter save: "These edits may have finished these tasks — complete them?" */
@Component({
  selector: 'app-task-fulfillment-dialog',
  imports: [MatDialogModule, MatButtonModule, MatCheckboxModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Did this finish {{ data.candidates.length === 1 ? 'a task' : 'some tasks' }}?</h2>
    <mat-dialog-content>
      <p class="intro">
        Your latest changes look like they may complete
        {{ data.candidates.length === 1 ? 'this task' : 'these tasks' }}.
      </p>
      <ul class="candidates">
        @for (c of data.candidates; track c.taskId) {
          <li>
            <mat-checkbox [checked]="selected().has(c.taskId)" (change)="toggle(c.taskId)">
              <span class="title">{{ c.title }}</span>
            </mat-checkbox>
            @if (c.reason) { <p class="reason">{{ c.reason }}</p> }
          </li>
        }
      </ul>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="[]">Not yet</button>
      <button mat-flat-button [disabled]="selected().size === 0" (click)="complete()">{{ confirmLabel() }}</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .intro { margin: 0 0 8px; }
    .candidates { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .title { font-weight: 500; }
    .reason { margin: 0 0 0 40px; font-size: 0.8125rem; color: var(--mat-sys-on-surface-variant); }
  `],
})
export class TaskFulfillmentDialogComponent {
  readonly data = inject<TaskFulfillmentDialogData>(MAT_DIALOG_DATA);
  private ref = inject<MatDialogRef<TaskFulfillmentDialogComponent, TaskFulfillmentDialogResult>>(MatDialogRef);

  readonly selected = signal<ReadonlySet<string>>(new Set(this.data.candidates.map(c => c.taskId)));
  readonly confirmLabel = computed(() => {
    const n = this.selected().size;
    return n <= 1 ? 'Complete task' : `Complete ${n} tasks`;
  });

  toggle(id: string): void {
    this.selected.update(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  complete(): void {
    this.ref.close([...this.selected()]);
  }
}
