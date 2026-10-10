import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppUpdateService } from './app-update.service';

describe('AppUpdateService', () => {
  function setup(win: object) {
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: win } }],
    });
    return TestBed.inject(AppUpdateService);
  }

  function fakeWindow(opts: { registrations?: number; cacheKeys?: string[]; failCaches?: boolean } = {}) {
    const registrations = Array.from({ length: opts.registrations ?? 0 }, () => ({
      unregister: vi.fn().mockResolvedValue(true),
    }));
    const caches = {
      keys: opts.failCaches
        ? vi.fn().mockRejectedValue(new Error('denied'))
        : vi.fn().mockResolvedValue(opts.cacheKeys ?? []),
      delete: vi.fn().mockResolvedValue(true),
    };
    const reload = vi.fn();
    const win = {
      navigator: { serviceWorker: { getRegistrations: vi.fn().mockResolvedValue(registrations) } },
      caches,
      location: { reload },
    };
    return { win, registrations, caches, reload };
  }

  it('unregisters every service worker, clears every cache, then reloads', async () => {
    const { win, registrations, caches, reload } = fakeWindow({ registrations: 2, cacheKeys: ['ngsw:a', 'ngsw:b'] });

    await setup(win).forceUpdate();

    registrations.forEach(r => expect(r.unregister).toHaveBeenCalled());
    expect(caches.delete).toHaveBeenCalledWith('ngsw:a');
    expect(caches.delete).toHaveBeenCalledWith('ngsw:b');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads where there is no service worker support', async () => {
    const reload = vi.fn();
    await setup({ navigator: {}, location: { reload } }).forceUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when clearing the caches fails', async () => {
    const { win, reload } = fakeWindow({ failCaches: true });
    await setup(win).forceUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
