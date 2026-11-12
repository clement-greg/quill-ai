import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { KnownUser, SaUsersResponse } from '@shared/models/sa-access.model';

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof HttpErrorResponse && typeof err.error?.error === 'string' ? err.error.error : fallback;
}

@Injectable({ providedIn: 'root' })
export class SaUsersService {
  private http = inject(HttpClient);
  readonly emails = signal<string[]>([]);
  readonly knownUsers = signal<KnownUser[]>([]);

  private apply(res: SaUsersResponse): void {
    this.emails.set(res.emails);
    this.knownUsers.set(res.knownUsers);
  }

  async load(): Promise<void> {
    try {
      this.apply(await firstValueFrom(this.http.get<SaUsersResponse>('/api/sa/users')));
    } catch {
      // Leave the lists as they were.
    }
  }

  /** Resolves to an error message, or null on success. */
  async grant(email: string): Promise<string | null> {
    try {
      this.apply(await firstValueFrom(this.http.post<SaUsersResponse>('/api/sa/users', { email })));
      return null;
    } catch (err) {
      return errorMessage(err, 'Could not grant SA access');
    }
  }

  async revoke(email: string): Promise<string | null> {
    try {
      this.apply(await firstValueFrom(this.http.delete<SaUsersResponse>(`/api/sa/users/${encodeURIComponent(email)}`)));
      return null;
    } catch (err) {
      return errorMessage(err, 'Could not remove SA access');
    }
  }
}
