import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Book } from '@shared/models/book.model';

@Injectable({ providedIn: 'root' })
export class BookService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/books';

  getAll(): Observable<Book[]> {
    return this.http.get<Book[]>(this.apiUrl);
  }

  getBySeries(seriesId: string): Observable<Book[]> {
    return this.http.get<Book[]>(`${this.apiUrl}/series/${seriesId}`);
  }

  getById(id: string): Observable<Book> {
    return this.http.get<Book>(`${this.apiUrl}/${id}`);
  }

  create(book: Book): Observable<Book> {
    return this.http.post<Book>(this.apiUrl, book);
  }

  update(book: Book): Observable<Book> {
    return this.http.put<Book>(`${this.apiUrl}/${book.id}`, book);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  archive(id: string): Observable<Book> {
    return this.http.patch<Book>(`${this.apiUrl}/${id}/archive`, {});
  }

  unarchive(id: string): Observable<Book> {
    return this.http.patch<Book>(`${this.apiUrl}/${id}/unarchive`, {});
  }

  softDelete(id: string): Observable<Book> {
    return this.http.patch<Book>(`${this.apiUrl}/${id}/soft-delete`, {});
  }

  restoreDelete(id: string): Observable<Book> {
    return this.http.patch<Book>(`${this.apiUrl}/${id}/restore-delete`, {});
  }

  getArchived(): Observable<Book[]> {
    return this.http.get<Book[]>(`${this.apiUrl}/archived`);
  }

  uploadThumbnail(file: File): Observable<{ url: string; thumbnailUrl: string }> {
    const formData = new FormData();
    formData.append('file', file);
    return this.http.post<{ url: string; thumbnailUrl: string }>('/api/upload', formData);
  }

  reorder(items: { id: string; sortOrder: number }[]): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/reorder`, items);
  }
}
