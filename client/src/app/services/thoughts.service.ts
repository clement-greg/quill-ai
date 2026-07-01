import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Thought } from '@shared/models/thought.model';

@Injectable({ providedIn: 'root' })
export class ThoughtsService {
  private http = inject(HttpClient);

  getAll(): Observable<Thought[]> {
    return this.http.get<Thought[]>('/api/thoughts');
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
