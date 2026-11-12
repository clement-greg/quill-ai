import { Component, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DatabaseRestorePreview } from '@shared/models/database-backup.model';
import { DatabaseBackupService, backupFileName } from './database-backup.service';

export interface RestoreBackupDialogData {
  blobName: string;
}

/**
 * Shows what a restore would add and skip, then asks for confirmation. Closes
 * with true when the user confirms; the caller starts the restore.
 */
@Component({
  selector: 'app-restore-backup-dialog',
  imports: [MatButtonModule, MatDialogModule, MatProgressSpinnerModule, DatePipe, DecimalPipe],
  template: `
    <h2 mat-dialog-title>Restore from backup?</h2>
    <mat-dialog-content>
      <p class="file">{{ fileName }}</p>
      @if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (!preview()) {
        <div class="loading"><mat-spinner diameter="28" /> Reading the backup…</div>
      } @else {
        @let p = preview()!;
        <p>
          Taken {{ p.backupCreatedAt | date: 'medium' }} from <strong>{{ p.sourceDatabase }}</strong>.
          Restoring only adds records that are missing. Records that still exist are skipped and
          never overwritten, so changes made since the backup are kept.
        </p>
        <p class="summary">
          <strong>{{ p.totals.toCreate | number }}</strong> records will be added ·
          {{ p.totals.alreadyExist | number }} already exist and will be skipped
        </p>
        @if (p.totals.toCreate > 0) {
          <table>
            <thead><tr><th>Container</th><th>Add</th><th>Skip</th></tr></thead>
            <tbody>
              @for (c of p.containers; track c.id) {
                @if (c.toCreate > 0) {
                  <tr>
                    <td>{{ c.id }}@if (c.containerMissing) { <span class="new"> (new container)</span> }</td>
                    <td>{{ c.toCreate | number }}</td>
                    <td>{{ c.alreadyExist | number }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button color="warn" [mat-dialog-close]="true"
        [disabled]="!preview() || preview()!.totals.toCreate === 0">
        Restore {{ preview()?.totals?.toCreate ?? 0 | number }} records
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    .file { font-family: monospace; font-size: 0.8125rem; margin: 0 0 12px; word-break: break-all; }
    .loading { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
    .error { color: var(--mat-sys-error); }
    .summary { margin: 12px 0; }
    .new { color: var(--mat-sys-on-surface-variant); font-size: 0.8125rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    th, td { text-align: left; padding: 4px 8px 4px 0; }
    th:not(:first-child), td:not(:first-child) { text-align: right; }
    thead th { border-bottom: 1px solid var(--mat-sys-outline-variant); }
  `],
})
export class RestoreBackupDialogComponent {
  private data = inject<RestoreBackupDialogData>(MAT_DIALOG_DATA);
  private backups = inject(DatabaseBackupService);

  readonly fileName = backupFileName(this.data.blobName);
  readonly preview = signal<DatabaseRestorePreview | null>(null);
  readonly error = signal<string | null>(null);

  constructor() {
    this.backups.previewRestore(this.data.blobName)
      .then(p => this.preview.set(p))
      .catch(() => this.error.set('Could not read this backup.'));
  }
}
