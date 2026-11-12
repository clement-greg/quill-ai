import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { AuthService } from '@app/core/auth/auth.service';
import { ConfirmDialogComponent } from '@app/shared/confirm-dialog/confirm-dialog';
import { DatabaseBackupService, backupFileName } from './database-backup.service';
import { SaUsersService } from './sa-users.service';
import { RestoreBackupDialogComponent } from './restore-backup-dialog';

/** Settings → Admin: SA users and database backups. Only rendered for SA users. */
@Component({
  selector: 'app-admin-settings',
  imports: [
    DatePipe, DecimalPipe, MatButtonModule, MatIconModule, MatInputModule,
    MatFormFieldModule, MatAutocompleteModule, MatTooltipModule,
  ],
  templateUrl: './admin-settings.html',
  styleUrl: './admin-settings.scss',
})
export class AdminSettingsComponent implements OnDestroy {
  private saUsers = inject(SaUsersService);
  private backups = inject(DatabaseBackupService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private auth = inject(AuthService);

  // ── SA users ──
  readonly saEmails = this.saUsers.emails;
  readonly myEmail = computed(() => this.auth.currentUser()?.email?.toLowerCase() ?? '');
  readonly newSaEmail = signal('');
  readonly savingSa = signal(false);
  /** Signed-in users who aren't SA yet, filtered by what's typed. */
  readonly saSuggestions = computed(() => {
    const query = this.newSaEmail().trim().toLowerCase();
    const current = new Set(this.saEmails());
    return this.saUsers.knownUsers()
      .filter(u => !current.has(u.email))
      .filter(u => !query || u.email.includes(query) || u.displayName?.toLowerCase().includes(query))
      .slice(0, 8);
  });

  // ── Backups ──
  readonly backupStatus = this.backups.status;
  readonly backupLoadError = this.backups.loadError;
  readonly startingBackup = signal(false);
  readonly busyBackup = signal<string | null>(null);
  readonly restoreRunning = computed(() => this.backupStatus()?.restore?.status === 'running');
  readonly backupTotalDocuments = computed(() => {
    const counts = this.backupStatus()?.lastRun?.documentCounts;
    return counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  });
  readonly restoreProgress = computed(() => {
    const r = this.backupStatus()?.restore;
    if (!r) return null;
    const total = r.containers.reduce((a, c) => a + c.inBackup, 0);
    return { done: r.created + r.skipped, total };
  });
  readonly backupFileName = backupFileName;

  constructor() {
    void this.saUsers.load();
    void this.backups.load();
  }

  ngOnDestroy(): void {
    this.backups.stopPolling();
  }

  private toast(message: string): void {
    this.snackBar.open(message, 'OK', { duration: 3500 });
  }

  async grantSa(email = this.newSaEmail()): Promise<void> {
    const trimmed = email.trim();
    if (!trimmed || this.savingSa()) return;
    this.savingSa.set(true);
    const error = await this.saUsers.grant(trimmed);
    this.savingSa.set(false);
    if (error) {
      this.toast(error);
      return;
    }
    this.newSaEmail.set('');
    this.toast(`${trimmed.toLowerCase()} now has SA access`);
  }

  revokeSa(email: string): void {
    this.dialog.open(ConfirmDialogComponent, {
      data: { title: 'Remove SA access?', message: `${email} will no longer be able to manage SA users or backups.`, confirm: 'Remove' },
      width: '380px',
    }).afterClosed().subscribe(async confirmed => {
      if (!confirmed) return;
      const error = await this.saUsers.revoke(email);
      this.toast(error ?? `Removed SA access for ${email}`);
    });
  }

  async runBackupNow(): Promise<void> {
    if (this.startingBackup() || this.backupStatus()?.running) return;
    this.startingBackup.set(true);
    const error = await this.backups.runNow();
    this.startingBackup.set(false);
    this.toast(error ?? 'Backup started');
  }

  async downloadBackup(blobName: string): Promise<void> {
    this.busyBackup.set(blobName);
    try {
      const blob = await this.backups.download(blobName);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = backupFileName(blobName);
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      this.toast('Could not download the backup');
    } finally {
      this.busyBackup.set(null);
    }
  }

  deleteBackup(blobName: string): void {
    this.dialog.open(ConfirmDialogComponent, {
      data: { title: 'Delete backup?', message: `${backupFileName(blobName)} will be permanently deleted. This cannot be undone.`, confirm: 'Delete' },
      width: '380px',
    }).afterClosed().subscribe(async confirmed => {
      if (!confirmed) return;
      this.busyBackup.set(blobName);
      const error = await this.backups.delete(blobName);
      this.busyBackup.set(null);
      this.toast(error ?? 'Backup deleted');
    });
  }

  restoreBackup(blobName: string): void {
    this.dialog.open(RestoreBackupDialogComponent, { data: { blobName }, width: '520px' })
      .afterClosed().subscribe(async confirmed => {
        if (!confirmed) return;
        const error = await this.backups.restore(blobName);
        this.toast(error ?? 'Restore started');
      });
  }
}
