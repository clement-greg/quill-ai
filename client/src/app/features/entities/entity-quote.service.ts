import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { EntityQuote } from '@shared/models/entity-quote.model';

@Injectable({ providedIn: 'root' })
export class EntityQuoteService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/entity-quotes';

  /** Syncs all detected quotes for a chapter. Returns the current persisted set. */
  sync(chapterId: string, quotes: { entityId: string; text: string }[]): Observable<EntityQuote[]> {
    return this.http.post<EntityQuote[]>(`${this.apiUrl}/sync`, { chapterId, quotes });
  }

  /** Gets all captured quotes for a given entity. */
  getByEntity(entityId: string): Observable<EntityQuote[]> {
    return this.http.get<EntityQuote[]>(`${this.apiUrl}/entity/${entityId}`);
  }

  /** Sets the isHighlighted flag on a quote. */
  setHighlight(id: string, entityId: string, isHighlighted: boolean): Observable<EntityQuote> {
    return this.http.patch<EntityQuote>(`${this.apiUrl}/${id}/highlight`, { entityId, isHighlighted });
  }

  /** Manually creates a new quote for an entity. */
  create(entityId: string, text: string): Observable<EntityQuote> {
    return this.http.post<EntityQuote>(`${this.apiUrl}`, { entityId, text });
  }

  /** Updates the text of an existing quote. */
  updateText(id: string, entityId: string, text: string): Observable<EntityQuote> {
    return this.http.patch<EntityQuote>(`${this.apiUrl}/${id}/text`, { entityId, text });
  }

  /** Permanently deletes a quote. */
  delete(id: string, entityId: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`, { body: { entityId } });
  }

  /** Uses AI to identify the speaker and creates a captured quote record. */
  capture(chapterId: string, quoteText: string, surroundingContext: string): Observable<{ quote: EntityQuote; entityName: string }> {
    return this.http.post<{ quote: EntityQuote; entityName: string }>(`${this.apiUrl}/capture`, { chapterId, quoteText, surroundingContext });
  }
}
