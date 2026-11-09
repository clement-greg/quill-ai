import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Thought, ThoughtPage } from '@shared/models/thought.model';

export interface ThoughtPageQuery {
  /** Only thoughts whose title, content or tags contain every word. */
  q?: string;
  /** Only thoughts carrying every one of these tags. */
  tags?: string[];
  offset: number;
  limit: number;
}

@Injectable({ providedIn: 'root' })
export class ThoughtsService {
  private http = inject(HttpClient);

  getPage(query: ThoughtPageQuery): Observable<ThoughtPage> {
    let params = new HttpParams().set('offset', query.offset).set('limit', query.limit);
    if (query.q?.trim()) params = params.set('q', query.q.trim());
    if (query.tags?.length) params = params.set('tags', query.tags.join(','));
    return this.http.get<ThoughtPage>('/api/thoughts', { params });
  }

  get(id: string): Observable<Thought> {
    return this.http.get<Thought>(`/api/thoughts/${encodeURIComponent(id)}`);
  }

  create(thought: Partial<Thought>): Observable<Thought> {
    return this.http.post<Thought>('/api/thoughts', thought);
  }

  update(id: string, thought: Partial<Thought>): Observable<Thought> {
    return this.http.put<Thought>(`/api/thoughts/${id}`, thought);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/thoughts/${id}`);
  }

  restore(id: string): Observable<Thought> {
    return this.http.patch<Thought>(`/api/thoughts/${id}/restore`, {});
  }
}
