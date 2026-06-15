import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { RecentChapter } from '@shared/models/recent-chapter.model';

export type { RecentChapter };

const MAX_ITEMS = 5;

@Injectable({ providedIn: 'root' })
export class RecentChaptersService {
  private http = inject(HttpClient);
  private readonly _items = signal<RecentChapter[]>([]);

  readonly recentChapters = this._items.asReadonly();

  constructor() {
    this.loadFromServer();
  }

  private async loadFromServer(): Promise<void> {
    try {
      const items = await firstValueFrom(this.http.get<RecentChapter[]>('/api/recent-chapters'));
      this._items.set(items);
    } catch {
      // Keep empty array on error — MRU is non-critical
    }
  }

  record(entry: Omit<RecentChapter, 'visitedAt'>): void {
    const updated = [
      { ...entry, visitedAt: Date.now() },
      ...this._items().filter(i => i.chapterId !== entry.chapterId),
    ].slice(0, MAX_ITEMS);
    this._items.set(updated);
    firstValueFrom(this.http.put<RecentChapter[]>('/api/recent-chapters', updated)).catch(() => {});
  }

  remove(chapterId: string): void {
    const updated = this._items().filter(i => i.chapterId !== chapterId);
    this._items.set(updated);
    firstValueFrom(this.http.put<RecentChapter[]>('/api/recent-chapters', updated)).catch(() => {});
  }
}
