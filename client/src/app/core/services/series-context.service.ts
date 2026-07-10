import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'quill_last_series_id';

/**
 * Tracks the series that is currently "in context" based on which page
 * the user is viewing. Page components (SeriesDetail, BookDetail, ChapterEdit)
 * push their resolved seriesId here via `set()`. The AI Assistant reads it
 * to auto-select the correct series when first opened.
 */
@Injectable({ providedIn: 'root' })
export class SeriesContextService {
  readonly currentSeriesId = signal<string | null>(localStorage.getItem(STORAGE_KEY));

  set(id: string | null): void {
    this.currentSeriesId.set(id);
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  clear(): void {
    this.set(null);
  }
}
