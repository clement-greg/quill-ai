import { Injectable, signal } from '@angular/core';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable({ providedIn: 'root' })
export class UpdateCheckService {
  readonly updateAvailable = signal(false);

  private initialHtml: string | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.fetchIndexHtml().then(html => {
      this.initialHtml = html;
    });

    this.intervalId = setInterval(() => this.checkForUpdate(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async fetchIndexHtml(): Promise<string | null> {
    try {
      const response = await fetch(`/index.html?_=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  private async checkForUpdate(): Promise<void> {
    if (this.updateAvailable()) return;

    const html = await this.fetchIndexHtml();
    if (!html) return;
    if (this.initialHtml === null) {
      // The startup fetch failed; adopt the first successful poll as baseline.
      this.initialHtml = html;
      return;
    }
    if (html !== this.initialHtml) {
      this.updateAvailable.set(true);
      this.stop();
    }
  }
}
