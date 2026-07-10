import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Series } from '@shared/models/series.model';

@Injectable({ providedIn: 'root' })
export class SeriesService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/series';

  getAll(): Observable<Series[]> {
    return this.http.get<Series[]>(this.apiUrl);
  }

  getById(id: string): Observable<Series> {
    return this.http.get<Series>(`${this.apiUrl}/${id}`);
  }

  create(series: Series): Observable<Series> {
    return this.http.post<Series>(this.apiUrl, series);
  }

  update(series: Series): Observable<Series> {
    return this.http.put<Series>(`${this.apiUrl}/${series.id}`, series);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  archive(id: string): Observable<Series> {
    return this.http.patch<Series>(`${this.apiUrl}/${id}/archive`, {});
  }

  unarchive(id: string): Observable<Series> {
    return this.http.patch<Series>(`${this.apiUrl}/${id}/unarchive`, {});
  }

  softDelete(id: string): Observable<Series> {
    return this.http.patch<Series>(`${this.apiUrl}/${id}/soft-delete`, {});
  }

  restoreDelete(id: string): Observable<Series> {
    return this.http.patch<Series>(`${this.apiUrl}/${id}/restore-delete`, {});
  }

  getArchived(): Observable<Series[]> {
    return this.http.get<Series[]>(`${this.apiUrl}/archived`);
  }

  uploadThumbnail(file: File): Observable<{ url: string; thumbnailUrl: string }> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post<{ url: string; thumbnailUrl: string }>('/api/upload', formData);
  }

  generateSystemPrompt(seriesId: string, basicPrompt: string): Observable<{ systemPrompt: string }> {
    return this.http.post<{ systemPrompt: string }>(`${this.apiUrl}/${seriesId}/generate-system-prompt`, { basicPrompt });
  }

  addCollaborator(seriesId: string, email: string): Observable<Series> {
    return this.http.post<Series>(`${this.apiUrl}/${seriesId}/collaborators`, { email });
  }

  removeCollaborator(seriesId: string, email: string): Observable<Series> {
    return this.http.delete<Series>(`${this.apiUrl}/${seriesId}/collaborators/${encodeURIComponent(email)}`);
  }
}
