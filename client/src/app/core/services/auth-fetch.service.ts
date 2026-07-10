import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';

// Auth endpoints handle their own errors; refreshing in response to their 401s
// would loop. Everything else under /api is a candidate for refresh-and-retry.
const isAuthEndpoint = (url: string) => url.startsWith('/api/auth/');

/**
 * Shared `fetch` wrapper for services that bypass Angular's HttpClient (e.g.
 * streaming chat endpoints, which need the raw Response body). Mirrors the
 * HttpClient auth interceptors: it attaches the bearer token, and on a 401 from
 * an authenticated API call it transparently refreshes the access token and
 * retries the request once. If the refresh itself fails, the session is
 * unrecoverable, so it runs the standard session-expired handling.
 *
 * Without this, fetch-based calls never hit the interceptors, so an expired
 * access token (short-lived by design) produced a hard 401 instead of a silent
 * refresh — fixed only by a full browser reload.
 */
@Injectable({ providedIn: 'root' })
export class AuthFetchService {
  private readonly auth = inject(AuthService);

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(input, this.withAuth(init, this.auth.idToken));

    // Only authenticated API calls (other than the auth endpoints themselves)
    // are eligible for refresh-and-retry; everything else returns as-is.
    if (res.status !== 401 || !input.startsWith('/api') || isAuthEndpoint(input)) {
      return res;
    }

    let newToken: string;
    try {
      newToken = await firstValueFrom(this.auth.refreshAccessToken());
    } catch (err) {
      this.auth.handleSessionExpired();
      throw err;
    }
    return fetch(input, this.withAuth(init, newToken));
  }

  private withAuth(init: RequestInit, token: string | null): RequestInit {
    const headers = new Headers(init.headers as HeadersInit);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return { ...init, headers };
  }
}
