import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Entity } from '@shared/models/entity.model';

export interface ChapterAppearance {
  id: string;
  title: string;
  sortOrder?: number;
  bookId: string;
  bookTitle: string;
}

@Injectable({ providedIn: 'root' })
export class EntityService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/entities';

  getAll(): Observable<Entity[]> {
    return this.http.get<Entity[]>(this.apiUrl);
  }

  getBySeries(seriesId: string): Observable<Entity[]> {
    return this.http.get<Entity[]>(`${this.apiUrl}/series/${seriesId}`);
  }

  getArchivedBySeries(seriesId: string): Observable<Entity[]> {
    return this.http.get<Entity[]>(`${this.apiUrl}/series/${seriesId}/archived`);
  }

  getById(id: string): Observable<Entity> {
    return this.http.get<Entity>(`${this.apiUrl}/${id}`);
  }

  create(entity: Entity): Observable<Entity> {
    return this.http.post<Entity>(this.apiUrl, entity);
  }

  update(entity: Entity): Observable<Entity> {
    return this.http.put<Entity>(`${this.apiUrl}/${entity.id}`, entity);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  archive(id: string): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${id}/archive`, {});
  }

  unarchive(id: string): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${id}/unarchive`, {});
  }

  softDelete(id: string): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${id}/soft-delete`, {});
  }

  restoreDelete(id: string): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${id}/restore-delete`, {});
  }

  getAllArchived(): Observable<Entity[]> {
    return this.http.get<Entity[]>(`${this.apiUrl}/archived`);
  }

  uploadThumbnail(file: File): Observable<{ url: string; thumbnailUrl: string }> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post<{ url: string; thumbnailUrl: string }>('/api/upload', formData);
  }

  generatePersonality(entityId: string, basicDescription: string): Observable<{ personality: string }> {
    return this.http.post<{ personality: string }>(`${this.apiUrl}/${entityId}/generate-personality`, { basicDescription });
  }

  generateBiography(entityId: string): Observable<{ biography: string }> {
    return this.http.post<{ biography: string }>(`${this.apiUrl}/${entityId}/generate-biography`, {});
  }

  generateImage(prompt: string, provider: 'gpt' | 'gemini' = 'gpt'): Observable<{ url: string; thumbnailUrl: string }> {
    return this.http.post<{ url: string; thumbnailUrl: string }>('/api/image/generate', { prompt, provider });
  }

  getOrCreateNarrator(seriesId: string): Observable<Entity> {
    return this.http.get<Entity>(`${this.apiUrl}/narrator/${seriesId}`);
  }

  reorder(ids: string[]): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/reorder`, { ids });
  }

  addPhoto(entityId: string, url: string, thumbnailUrl: string, hidden = false): Observable<Entity> {
    return this.http.post<Entity>(`${this.apiUrl}/${entityId}/photos`, { url, thumbnailUrl, hidden });
  }

  removePhoto(entityId: string, index: number): Observable<Entity> {
    return this.http.delete<Entity>(`${this.apiUrl}/${entityId}/photos/${index}`);
  }

  setPhotosHidden(entityId: string, indices: number[], hidden: boolean): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${entityId}/photos/visibility`, { indices, hidden });
  }

  reorderPhotos(entityId: string, order: number[]): Observable<Entity> {
    return this.http.patch<Entity>(`${this.apiUrl}/${entityId}/photos/reorder`, { order });
  }

  getChapterAppearances(entityId: string): Observable<ChapterAppearance[]> {
    return this.http.get<ChapterAppearance[]>(`${this.apiUrl}/${entityId}/chapters`);
  }

  getMentionCounts(seriesId: string): Observable<{ counts: Record<string, number> }> {
    return this.http.get<{ counts: Record<string, number> }>(`${this.apiUrl}/series/${seriesId}/mention-counts`);
  }
}
