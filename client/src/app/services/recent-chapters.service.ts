import { Injectable, signal } from '@angular/core';

export interface RecentChapter {
  chapterId: string;
  chapterTitle: string;
  bookTitle: string;
  seriesTitle: string;
  thumbnailUrl?: string;
  visitedAt: number;
}

const STORAGE_KEY = 'quill-recent-chapters';
const MAX_ITEMS = 5;

@Injectable({ providedIn: 'root' })
export class RecentChaptersService {
  private readonly _items = signal<RecentChapter[]>(this.load());

  readonly recentChapters = this._items.asReadonly();

  remove(chapterId: string): void {
    this._items.update(items => {
      const updated = items.filter(i => i.chapterId !== chapterId);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  record(entry: Omit<RecentChapter, 'visitedAt'>): void {
    this._items.update(items => {
      const filtered = items.filter(i => i.chapterId !== entry.chapterId);
      const updated = [{ ...entry, visitedAt: Date.now() }, ...filtered].slice(0, MAX_ITEMS);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  }

  private load(): RecentChapter[] {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    } catch {
      return [];
    }
  }
}
