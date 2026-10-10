import { Injectable } from '@angular/core';

interface CacheEntry<T> {
  date: string;
  data: T;
}

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Client-side cache for the "Your Writing" summary, invalidated on chapter save or day change. */
@Injectable({ providedIn: 'root' })
export class WritingStatsCacheService {
  // Bump the suffix whenever the server's stats calculation changes, so a
  // summary computed by the old logic isn't shown for the rest of the day.
  private readonly storageKey = 'writing-stats-summary-cache-v2';

  get<T>(): T | null {
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) return null;

    let entry: CacheEntry<T>;
    try {
      entry = JSON.parse(raw);
    } catch {
      return null;
    }

    return entry.date === localDateStr() ? entry.data : null;
  }

  set<T>(data: T): void {
    const entry: CacheEntry<T> = { date: localDateStr(), data };
    localStorage.setItem(this.storageKey, JSON.stringify(entry));
  }

  invalidate(): void {
    localStorage.removeItem(this.storageKey);
  }
}
