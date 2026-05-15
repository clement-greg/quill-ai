import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Chapter } from '@shared/models/chapter.model';

@Injectable({ providedIn: 'root' })
export class ChapterService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/chapters';

  getAll(): Observable<Chapter[]> {
    return this.http.get<Chapter[]>(this.apiUrl);
  }

  getByBook(bookId: string): Observable<Chapter[]> {
    return this.http.get<Chapter[]>(`${this.apiUrl}/book/${bookId}`);
  }

  getById(id: string): Observable<Chapter> {
    return this.http.get<Chapter>(`${this.apiUrl}/${id}`);
  }

  create(chapter: Chapter): Observable<Chapter> {
    return this.http.post<Chapter>(this.apiUrl, chapter);
  }

  update(chapter: Chapter): Observable<Chapter> {
    return this.http.put<Chapter>(`${this.apiUrl}/${chapter.id}`, chapter);
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
}
