import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { DatabaseBackupStatus } from '@shared/models/database-backup.model';

/** How often status is re-read while a backup is running. */
const POLL_MS = 4000;

@Injectable({ providedIn: 'root' })
export class DatabaseBackupService {
  private http = inject(HttpClient);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  private _status = signal<DatabaseBackupStatus | null>(null);
  readonly status = this._status.asReadonly();
  readonly loadError = signal(false);

  async load(): Promise<void> {
    try {
      const status = await firstValueFrom(this.http.get<DatabaseBackupStatus>('/api/backups'));
      this._status.set(status);
      this.loadError.set(false);
      if (status.running) this.schedulePoll();
    } catch {
      this.loadError.set(true);
    }
  }

  /** Starts a backup. Resolves to an error message, or null once it has started. */
  async runNow(): Promise<string | null> {
    try {
      await firstValueFrom(this.http.post('/api/backups/run', {}));
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 409) {
        await this.load();
        return 'A backup is already running';
      }
      return 'Could not start the backup';
    }
    await this.load();
    return null;
  }

  stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private schedulePoll(): void {
    this.stopPolling();
    this.pollTimer = setTimeout(() => void this.load(), POLL_MS);
  }
}
