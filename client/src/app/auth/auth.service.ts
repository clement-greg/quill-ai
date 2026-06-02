import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
const USER_KEY = 'google_user';
const COOKIE_NAME = 'quill_auth';
const COOKIE_MAX_AGE_S = 48 * 60 * 60; // 48 hours, matching TOKEN_EXPIRY

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  readonly currentUser = signal<GoogleUser | null>(this.loadStoredUser());

  get idToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  get isLoggedIn(): boolean {
    return this.currentUser() !== null;
  }

  /** Called by the login component after Google returns a credential. */
  async handleCredentialResponse(credential: string): Promise<void> {
    const { token } = await firstValueFrom(
      this.http.post<{ token: string }>('/api/auth/login', { credential })
    );

    const payload = this.parseJwtPayload(credential);
    const user: GoogleUser = {
      email: payload['email'] as string,
      name: payload['name'] as string,
      picture: payload['picture'] as string,
      idToken: token,
    };
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify({ email: user.email, name: user.name, picture: user.picture }));
    this.setCookieToken(token);
    this.currentUser.set(user);
  }

  signOut(): void {
    const user = this.currentUser();
    if (user && typeof google !== 'undefined') {
      google.accounts.id.disableAutoSelect();
      google.accounts.id.revoke(user.email, () => {});
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    this.clearCookieToken();
    this.currentUser.set(null);
  }

  private loadStoredUser(): GoogleUser | null {
    try {
      let token = localStorage.getItem(TOKEN_KEY);
      let raw = localStorage.getItem(USER_KEY);

      // iOS PWA: localStorage is isolated from Safari. Recover session from the
      // cookie that was written when auth completed (possibly in Safari).
      if (!token) {
        token = this.getCookieToken();
        if (token) {
          // Re-populate localStorage so subsequent reads are fast.
          localStorage.setItem(TOKEN_KEY, token);
        }
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

      // Check token expiry before trusting the stored session
      const payload = this.parseJwtPayload(token);
      const exp = (payload['exp'] as number | undefined) ?? 0;
      if (Date.now() / 1000 > exp) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        return null;
      }

      const stored = JSON.parse(raw);
      return { ...stored, idToken: token };
    } catch {
      return null;
    }
  }

  private setCookieToken(token: string): void {
    try {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie =
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
    } catch { /* non-browser environment */ }
  }

  private getCookieToken(): string | null {
    try {
      const match = document.cookie
        .split('; ')
        .find(row => row.startsWith(`${COOKIE_NAME}=`));
      return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
    } catch {
      return null;
    }
  }

  private clearCookieToken(): void {
    try {
      document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
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
