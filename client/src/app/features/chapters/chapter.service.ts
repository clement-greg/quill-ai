import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { Chapter } from '@shared/models/chapter.model';
import { ContentFilterWarning } from '@shared/models/chapter-chunk.model';
import { WritingStatsCacheService } from '@app/features/writing-stats/writing-stats-cache.service';
import { DialogueTaggingService } from './dialogue-tagging.service';

/** A chapter save response, optionally carrying paragraphs the content filter
 * kept out of the search index. */
export type ChapterSaveResult = Chapter & { contentWarnings?: ContentFilterWarning[] };

@Injectable({ providedIn: 'root' })
export class ChapterService {
  private http = inject(HttpClient);
  private writingStatsCache = inject(WritingStatsCacheService);
  private dialogue = inject(DialogueTaggingService);
  private readonly apiUrl = '/api/chapters';

  getAll(): Observable<Chapter[]> {
    return this.http.get<Chapter[]>(this.apiUrl);
  }

  getByBook(bookId: string): Observable<Chapter[]> {
    return this.http.get<Chapter[]>(`${this.apiUrl}/book/${bookId}`)
      .pipe(tap(list => list.forEach(c => this.dialogue.seed(c))));
  }

  getById(id: string): Observable<Chapter> {
    return this.http.get<Chapter>(`${this.apiUrl}/${id}`).pipe(tap(c => this.dialogue.seed(c)));
  }

  create(chapter: Chapter): Observable<ChapterSaveResult> {
    return this.http.post<ChapterSaveResult>(this.apiUrl, chapter)
      .pipe(tap(saved => this.afterSave(saved)));
  }

  update(chapter: Chapter): Observable<ChapterSaveResult> {
    return this.http.put<ChapterSaveResult>(`${this.apiUrl}/${chapter.id}`, chapter)
      .pipe(tap(saved => this.afterSave(saved)));
  }

  /** Stats are stale, and new dialogue needs its speakers worked out (in the background). */
  private afterSave(saved: Chapter): void {
    this.writingStatsCache.invalidate();
    this.dialogue.tag(saved);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  archive(id: string): Observable<Chapter> {
    return this.http.patch<Chapter>(`${this.apiUrl}/${id}/archive`, {});
  }

  unarchive(id: string): Observable<Chapter> {
    return this.http.patch<Chapter>(`${this.apiUrl}/${id}/unarchive`, {});
  }

  getArchived(): Observable<Chapter[]> {
    return this.http.get<Chapter[]>(`${this.apiUrl}/archived`);
  }

  reorder(items: { id: string; sortOrder: number }[]): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/reorder`, items);
  }

  uploadImage(file: File): Observable<{ url: string; thumbnailUrl: string }> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post<{ url: string; thumbnailUrl: string }>('/api/upload', formData);
  }

  /** Generates a chapter image from a text prompt. */
  generateImage(prompt: string): Observable<{ url: string; thumbnailUrl: string }> {
    return this.http.post<{ url: string; thumbnailUrl: string }>('/api/image/generate', { prompt });
  }

  /** Asks the model for an image prompt describing a scene from the chapter text. */
  suggestImagePrompt(text: string, title?: string): Observable<{ prompt: string }> {
    return this.http.post<{ prompt: string }>('/api/image/suggest-prompt', { text, title });
  }
}
