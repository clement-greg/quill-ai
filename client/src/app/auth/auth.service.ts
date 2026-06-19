import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Observable, firstValueFrom, throwError } from 'rxjs';
import { finalize, map, shareReplay, tap } from 'rxjs/operators';

export interface GoogleUser {
  email: string;
  name: string;
  picture: string;
  idToken: string;
}

// Declare the google namespace provided by the GIS SDK script
declare const google: {
  accounts: {
    id: {
      initialize(config: object): void;
      renderButton(parent: HTMLElement, config: object): void;
      prompt(): void;
      disableAutoSelect(): void;
      revoke(email: string, done: () => void): void;
    };
  };
};

const TOKEN_KEY = 'app_auth_token';
const REFRESH_KEY = 'app_refresh_token';
const USER_KEY = 'google_user';
const COOKIE_NAME = 'quill_auth';
const REFRESH_COOKIE_NAME = 'quill_refresh';
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days, matching REFRESH_TOKEN_EXPIRY

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private snackBar = inject(MatSnackBar);
  readonly currentUser = signal<GoogleUser | null>(this.loadStoredUser());

  // Shared in-flight refresh so that a burst of concurrent 401s triggers exactly
  // one /refresh call; all callers await the same result.
  private refreshInFlight$: Observable<string> | null = null;
  // Guards handleSessionExpired so concurrent failures show a single prompt.
  private sessionExpiredHandled = false;

  get idToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  get refreshToken(): string | null {
    return localStorage.getItem(REFRESH_KEY) ?? this.getCookie(REFRESH_COOKIE_NAME);
  }

  get isLoggedIn(): boolean {
    return this.currentUser() !== null;
  }

  /** Called by the login component after Google returns a credential. */
  async handleCredentialResponse(credential: string): Promise<void> {
    const { token, refreshToken } = await firstValueFrom(
      this.http.post<{ token: string; refreshToken: string }>('/api/auth/login', { credential })
    );

    const payload = this.parseJwtPayload(credential);
    const user: GoogleUser = {
      email: payload['email'] as string,
      name: payload['name'] as string,
      picture: payload['picture'] as string,
      idToken: token,
    };
    localStorage.setItem(USER_KEY, JSON.stringify({ email: user.email, name: user.name, picture: user.picture }));
    this.storeTokens(token, refreshToken);
    this.sessionExpiredHandled = false;
    this.currentUser.set(user);
  }

  /**
   * Exchanges the stored refresh token for a fresh access token (and a rotated
   * refresh token), returning the new access token. Concurrent callers share a
   * single in-flight request. Errors propagate so the caller can sign out.
   */
  refreshAccessToken(): Observable<string> {
    if (this.refreshInFlight$) return this.refreshInFlight$;

    const refreshToken = this.refreshToken;
    if (!refreshToken) {
      return throwError(() => new Error('No refresh token available'));
    }

    this.refreshInFlight$ = this.http
      .post<{ token: string; refreshToken: string }>('/api/auth/refresh', { refreshToken })
      .pipe(
        tap(res => this.storeTokens(res.token, res.refreshToken)),
        map(res => res.token),
        finalize(() => { this.refreshInFlight$ = null; }),
        shareReplay(1),
      );
    return this.refreshInFlight$;
  }

  /**
   * Called when the session can no longer be recovered (refresh failed/expired).
   * Clears the session, tells the user, and routes to the login screen. Safe to
   * call repeatedly — only the first call takes effect.
   */
  handleSessionExpired(): void {
    if (this.sessionExpiredHandled) return;
    this.sessionExpiredHandled = true;
    this.signOut();
    this.snackBar.open('Your session has expired. Please sign in again.', 'Sign in', { duration: 8000 });
    this.router.navigate(['/login']);
  }

  signOut(): void {
    const user = this.currentUser();
    if (user && typeof google !== 'undefined') {
      google.accounts.id.disableAutoSelect();
      google.accounts.id.revoke(user.email, () => {});
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    this.clearCookie(COOKIE_NAME);
    this.clearCookie(REFRESH_COOKIE_NAME);
    this.currentUser.set(null);
  }

  private storeTokens(accessToken: string, refreshToken?: string): void {
    localStorage.setItem(TOKEN_KEY, accessToken);
    this.setCookie(COOKIE_NAME, accessToken);
    // Keep the current user's idToken in sync after a refresh.
    const user = this.currentUser();
    if (user) this.currentUser.set({ ...user, idToken: accessToken });
    if (refreshToken) {
      localStorage.setItem(REFRESH_KEY, refreshToken);
      this.setCookie(REFRESH_COOKIE_NAME, refreshToken);
    }
  }

  private loadStoredUser(): GoogleUser | null {
    try {
      let token = localStorage.getItem(TOKEN_KEY);
      let raw = localStorage.getItem(USER_KEY);

      // iOS PWA: localStorage is isolated from Safari. Recover session from the
      // cookie that was written when auth completed (possibly in Safari).
      if (!token) {
        token = this.getCookie(COOKIE_NAME);
        if (token) {
          // Re-populate localStorage so subsequent reads are fast.
          localStorage.setItem(TOKEN_KEY, token);
        }
      }
      // Recover the refresh token from its cookie too (iOS PWA path).
      if (!localStorage.getItem(REFRESH_KEY)) {
        const rt = this.getCookie(REFRESH_COOKIE_NAME);
        if (rt) localStorage.setItem(REFRESH_KEY, rt);
      }

      if (!token) return null;

      // If user JSON is missing (e.g. recovered from cookie after iOS PWA/Safari
      // context switch), derive it from the JWT payload and repopulate storage.
      if (!raw) {
        const p = this.parseJwtPayload(token);
        const derived = { email: p['email'] as string, name: p['name'] as string, picture: p['picture'] as string };
        localStorage.setItem(USER_KEY, JSON.stringify(derived));
        raw = JSON.stringify(derived);
      }

      // The access token is short-lived, so an expired one is normal. Keep the
      // session alive as long as the refresh token is still valid — the error
      // interceptor will transparently refresh on the next API call. Only treat
      // the session as dead when the refresh token is also gone/expired.
      if (this.isTokenExpired(token)) {
        const refresh = localStorage.getItem(REFRESH_KEY);
        if (!refresh || this.isTokenExpired(refresh)) {
          this.signOut();
          return null;
        }
      }

      const stored = JSON.parse(raw);
      return { ...stored, idToken: token };
    } catch {
      return null;
    }
  }

  /** True if the JWT's exp claim is in the past (or unreadable). */
  private isTokenExpired(token: string): boolean {
    try {
      const exp = (this.parseJwtPayload(token)['exp'] as number | undefined) ?? 0;
      return Date.now() / 1000 > exp;
    } catch {
      return true;
    }
  }

  private setCookie(name: string, value: string): void {
    try {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie =
        `${name}=${encodeURIComponent(value)}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
    } catch { /* non-browser environment */ }
  }

  private getCookie(name: string): string | null {
    try {
      const match = document.cookie
        .split('; ')
        .find(row => row.startsWith(`${name}=`));
      return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
    } catch {
      return null;
    }
  }

  private clearCookie(name: string): void {
    try {
      document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
    } catch { /* non-browser environment */ }
  }

  private parseJwtPayload(token: string): Record<string, unknown> {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(json);
  }
}
