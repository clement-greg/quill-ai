import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { vi, type Mock } from 'vitest';
import { AuthFetchService } from './auth-fetch.service';
import { AuthService } from '../auth/auth.service';

/** Reads the Authorization header off the init arg of a recorded fetch call. */
function authHeader(call: unknown[]): string | null {
  const init = call[1] as RequestInit;
  return new Headers(init.headers as HeadersInit).get('Authorization');
}

describe('AuthFetchService', () => {
  let service: AuthFetchService;
  let fetchMock: Mock;
  let authStub: {
    idToken: string | null;
    refreshAccessToken: Mock;
    handleSessionExpired: Mock;
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    authStub = {
      idToken: 'access-token',
      refreshAccessToken: vi.fn(() => of('fresh-token')),
      handleSessionExpired: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [{ provide: AuthService, useValue: authStub }],
    });
    service = TestBed.inject(AuthFetchService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('attaches the bearer token to the request', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    await service.fetch('/api/chat-sessions');

    expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer access-token');
  });

  it('omits the Authorization header when no token is stored', async () => {
    authStub.idToken = null;
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

    await service.fetch('/api/chat-sessions');

    expect(authHeader(fetchMock.mock.calls[0])).toBeNull();
  });

  it('returns a non-401 response without attempting a refresh', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));

    const res = await service.fetch('/api/chat-sessions');

    expect(res.status).toBe(500);
    expect(authStub.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes the token and retries once on a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await service.fetch('/api/chat-sessions', { method: 'POST' });

    expect(authStub.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry carries the refreshed token and preserves the original init.
    expect(authHeader(fetchMock.mock.calls[1])).toBe('Bearer fresh-token');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
    expect(res.status).toBe(200);
    expect(authStub.handleSessionExpired).not.toHaveBeenCalled();
  });

  it('handles session expiry and rethrows when the refresh fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));
    authStub.refreshAccessToken.mockReturnValue(throwError(() => new Error('refresh dead')));

    await expect(service.fetch('/api/chat-sessions')).rejects.toThrow('refresh dead');

    expect(authStub.handleSessionExpired).toHaveBeenCalledTimes(1);
    // No retry was attempted after the failed refresh.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on a 401 from an auth endpoint (avoids a refresh loop)', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));

    const res = await service.fetch('/api/auth/refresh', { method: 'POST' });

    expect(res.status).toBe(401);
    expect(authStub.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on a 401 from a non-API URL', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));

    const res = await service.fetch('https://external.example.com/data');

    expect(res.status).toBe(401);
    expect(authStub.refreshAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
