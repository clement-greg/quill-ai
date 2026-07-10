import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { AuthService } from './auth.service';

/** Build a minimal signed JWT with the given payload. */
function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.fakesig`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600;

describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('isLoggedIn is false when localStorage is empty', () => {
    expect(service.isLoggedIn).toBe(false);
  });

  it('idToken returns null when no token stored', () => {
    expect(service.idToken).toBeNull();
  });

  it('idToken returns stored token', () => {
    localStorage.setItem('app_auth_token', 'my-token');
    expect(service.idToken).toBe('my-token');
  });

  it('handleCredentialResponse stores token and sets currentUser', async () => {
    const credential = makeJwt({
      email: 'user@example.com',
      name: 'Test User',
      picture: 'https://example.com/pic.jpg',
      exp: FUTURE_EXP,
    });
    const serverToken = makeJwt({ email: 'user@example.com', exp: FUTURE_EXP });

    const promise = service.handleCredentialResponse(credential);
    httpMock.expectOne('/api/auth/login').flush({ token: serverToken });
    await promise;

    expect(service.isLoggedIn).toBe(true);
    expect(service.currentUser()?.email).toBe('user@example.com');
    expect(service.currentUser()?.name).toBe('Test User');
    expect(localStorage.getItem('app_auth_token')).toBe(serverToken);
  });

  it('signOut clears localStorage and sets currentUser to null', () => {
    const token = makeJwt({ email: 'user@example.com', exp: FUTURE_EXP });
    service.currentUser.set({ email: 'user@example.com', name: 'Test User', picture: '', idToken: token });
    localStorage.setItem('app_auth_token', token);
    localStorage.setItem('google_user', JSON.stringify({ email: 'user@example.com', name: 'Test User', picture: '' }));

    service.signOut();

    expect(service.isLoggedIn).toBe(false);
    expect(service.currentUser()).toBeNull();
    expect(localStorage.getItem('app_auth_token')).toBeNull();
    expect(localStorage.getItem('google_user')).toBeNull();
  });

  it('loadStoredUser returns null when token is expired', () => {
    const expiredToken = makeJwt({ email: 'x@x.com', exp: 1 });
    localStorage.setItem('app_auth_token', expiredToken);
    localStorage.setItem('google_user', JSON.stringify({ email: 'x@x.com', name: 'X', picture: '' }));

    // Re-create service so loadStoredUser() runs with the stale token
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const freshService = TestBed.inject(AuthService);

    expect(freshService.isLoggedIn).toBe(false);
  });
});
