import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { UpdateCheckService } from './update-check.service';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

describe('UpdateCheckService', () => {
  let service: UpdateCheckService;
  let fetchMock: ReturnType<typeof vi.fn>;

  function htmlResponse(html: string): Response {
    return new Response(html, { status: 200 });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => htmlResponse('<html>v1</html>'));
    vi.stubGlobal('fetch', fetchMock);

    TestBed.configureTestingModule({});
    service = TestBed.inject(UpdateCheckService);
  });

  afterEach(() => {
    service.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('captures the initial index.html on start without flagging an update', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.updateAvailable()).toBe(false);
  });

  it('stays quiet while the served html is unchanged', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(service.updateAvailable()).toBe(false);
  });

  it('flags an update when index.html changes, then stops polling', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    fetchMock.mockResolvedValue(htmlResponse('<html>v2</html>'));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(service.updateAvailable()).toBe(true);

    // Polling stopped: no further fetches on later ticks.
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('does not flag an update when the fetch fails', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    fetchMock.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(service.updateAvailable()).toBe(false);
  });

  it('recovers from a failed startup fetch without falsely flagging an update', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline at startup'));
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    // First successful poll becomes the baseline — no update flagged.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(service.updateAvailable()).toBe(false);

    // Unchanged html on the next poll still stays quiet.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(service.updateAvailable()).toBe(false);

    // A real change after the baseline is adopted is detected.
    fetchMock.mockResolvedValue(htmlResponse('<html>v2</html>'));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(service.updateAvailable()).toBe(true);
  });

  it('ignores non-OK responses when establishing the baseline', async () => {
    fetchMock.mockResolvedValueOnce(new Response('server error', { status: 500 }));
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(service.updateAvailable()).toBe(false);
  });

  it('stop() halts the polling interval', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.stop();

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial fetch
  });

  it('bypasses caches when fetching index.html', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/index.html?_=');
    expect(init.cache).toBe('no-store');
  });
});
