import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, retry, timer } from 'rxjs';
import { RecentChapter } from '@shared/models/recent-chapter.model';

export type { RecentChapter };

@Injectable({ providedIn: 'root' })
export class RecentChaptersService {
  private http = inject(HttpClient);
  private readonly _items = signal<RecentChapter[]>([]);

  /** The most recent distinct chapters, newest first, as computed by the server. */
  readonly recentChapters = this._items.asReadonly();

  constructor() {
    this.refresh();
  }

  /**
   * Loads the canonical list from the server. The server derives it from the
   * append-only visit log, so this is purely a read — it can never destroy
   * history. Retries transient failures (e.g. Cosmos cold-start/throttling,
   * which are not 401s and so bypass the auth refresh interceptor).
   */
  async refresh(): Promise<void> {
    try {
      const items = await firstValueFrom(
        this.http.get<RecentChapter[]>('/api/recent-chapters').pipe(
          retry({ count: 3, delay: (_err, n) => timer(Math.min(1000 * 2 ** n, 8000)) }),
        ),
      );
      this._items.set(items);
    } catch {
      // Leave the existing list in place; the next load reconciles.
    }
  }

  /** Records a chapter visit (one immutable insert), then refreshes the list. */
  async record(entry: Omit<RecentChapter, 'visitedAt'>): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/recent-chapters', entry));
      await this.refresh();
    } catch {
      // Recording is non-critical; leave the existing list untouched on failure.
    }
  }
}
