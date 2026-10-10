import { DOCUMENT, Injectable, inject } from '@angular/core';

/**
 * Gets an installed copy of the app — notably one added to an iPhone home
 * screen, which has no reload button — off a stale build. The service worker
 * keeps serving the version it cached until it notices a newer one, so this
 * skips the wait: it drops the worker and everything it cached, then reloads
 * straight from the server. The worker registers itself again once the fresh
 * page settles.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private document = inject(DOCUMENT);

  async forceUpdate(): Promise<void> {
    const win = this.document.defaultView;
    if (!win) return;
    try {
      const registrations = (await win.navigator.serviceWorker?.getRegistrations()) ?? [];
      await Promise.all(registrations.map(r => r.unregister()));
      if ('caches' in win) {
        const keys = await win.caches.keys();
        await Promise.all(keys.map(k => win.caches.delete(k)));
      }
    } catch {
      // Even if clearing failed part-way, a reload is the best remaining shot.
    }
    win.location.reload();
  }
}
