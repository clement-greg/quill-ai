import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, retry, timer } from 'rxjs';
import { RecentChapter } from '@shared/models/recent-chapter.model';

export type { RecentChapter };

@Injectable({ providedIn: 'root' })
export class RecentChaptersService {
  private http = inject(HttpClient);
  private readonly _items = signal<RecentChapter[]>([]);

  readonly recentChapters = this._items.asReadonly();

  constructor() {
    this.loadFromServer();
  }

  /**
   * Loads the canonical list from the server. Retries transient failures (e.g.
   * Cosmos cold-start/throttling, which are not 401s and so bypass the auth
   * refresh interceptor) so a single startup hiccup doesn't leave the list
   * empty. The list is never persisted from the client cache, so even a total
   * load failure can no longer destroy the saved history on the next write.
   */
  private async loadFromServer(): Promise<void> {
    try {
      const items = await firstValueFrom(
        this.http.get<RecentChapter[]>('/api/recent-chapters').pipe(
          retry({ count: 3, delay: (_err, n) => timer(Math.min(1000 * 2 ** n, 8000)) }),
        ),
      );
      this._items.set(items);
    } catch {
      // Keep whatever we already have; the next successful read or write will
      // reconcile from the server. Never overwrite the server from here.
    }
  }

  /**
   * Records a chapter visit. The server owns the merge (read → prepend → dedupe
   * → trim), so the client's local state can never clobber the persisted list.
   * We adopt the canonical list the server returns.
   */
  async record(entry: Omit<RecentChapter, 'visitedAt'>): Promise<void> {
    try {
      const updated = await firstValueFrom(
        this.http.post<RecentChapter[]>('/api/recent-chapters', entry),
      );
      this._items.set(updated);
    } catch {
      // Recording is non-critical; leave existing state untouched on failure.
    }
  }

  async remove(chapterId: string): Promise<void> {
    // Optimistic local removal for snappy UI; reconcile with the server result.
    this._items.set(this._items().filter(i => i.chapterId !== chapterId));
    try {
      const updated = await firstValueFrom(
        this.http.delete<RecentChapter[]>(`/api/recent-chapters/${chapterId}`),
      );
      this._items.set(updated);
    } catch {
      // Local optimistic state stands; a later load will reconcile.
    }
  }
}
