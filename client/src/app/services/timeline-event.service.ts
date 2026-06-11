import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  TimelineEvent,
  TimelineExtractionResult,
  ApplyTimelineProposalsRequest,
  ApplyTimelineProposalsResult,
} from '@shared/models/timeline-event.model';

@Injectable({ providedIn: 'root' })
export class TimelineEventService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/timeline-events';

  getByEntity(entityId: string): Observable<TimelineEvent[]> {
    return this.http.get<TimelineEvent[]>(`${this.apiUrl}/entity/${entityId}`);
  }

  create(event: Partial<TimelineEvent>): Observable<TimelineEvent> {
    return this.http.post<TimelineEvent>(this.apiUrl, event);
  }

  update(event: TimelineEvent): Observable<TimelineEvent> {
    return this.http.put<TimelineEvent>(`${this.apiUrl}/${event.id}`, event);
  }

  delete(entityId: string, id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${entityId}/${id}`);
  }

  reorder(entityId: string, ids: string[]): Observable<void> {
    return this.http.patch<void>(`${this.apiUrl}/entity/${entityId}/reorder`, { ids });
  }

  /** Analyze chapter text for major plot events and propose timeline changes (nothing is persisted). */
  extractFromChapter(chapterId: string, seriesId: string, text: string): Observable<TimelineExtractionResult> {
    return this.http.post<TimelineExtractionResult>(`${this.apiUrl}/extract-from-chapter`, { chapterId, seriesId, text });
  }

  /** Persist the proposals the user accepted. */
  applyChapterProposals(request: ApplyTimelineProposalsRequest): Observable<ApplyTimelineProposalsResult> {
    return this.http.post<ApplyTimelineProposalsResult>(`${this.apiUrl}/apply-chapter-proposals`, request);
  }
}
