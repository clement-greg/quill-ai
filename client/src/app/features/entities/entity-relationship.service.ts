import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  EntityRelationship,
  EntityRelationshipSummary,
  DiagramLayout,
  RelationshipExtractionResult,
  ApplyRelationshipProposalsRequest,
  ApplyRelationshipProposalsResult,
} from '@shared/models/entity-relationship.model';

@Injectable({ providedIn: 'root' })
export class EntityRelationshipService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/entity-relationships';

  getBySeries(seriesId: string): Observable<EntityRelationship[]> {
    return this.http.get<EntityRelationship[]>(`${this.apiUrl}/series/${seriesId}`);
  }

  getByEntity(entityId: string): Observable<EntityRelationshipSummary[]> {
    return this.http.get<EntityRelationshipSummary[]>(`${this.apiUrl}/entity/${entityId}`);
  }

  create(relationship: EntityRelationship): Observable<EntityRelationship> {
    return this.http.post<EntityRelationship>(this.apiUrl, relationship);
  }

  update(relationship: EntityRelationship): Observable<EntityRelationship> {
    return this.http.put<EntityRelationship>(`${this.apiUrl}/${relationship.id}`, relationship);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/${id}`);
  }

  extractFromChapter(chapterId: string, seriesId: string, text: string): Observable<RelationshipExtractionResult> {
    return this.http.post<RelationshipExtractionResult>(`${this.apiUrl}/extract-from-chapter`, { chapterId, seriesId, text });
  }

  applyChapterProposals(request: ApplyRelationshipProposalsRequest): Observable<ApplyRelationshipProposalsResult> {
    return this.http.post<ApplyRelationshipProposalsResult>(`${this.apiUrl}/apply-chapter-proposals`, request);
  }

  getLayout(seriesId: string): Observable<DiagramLayout | null> {
    return this.http.get<DiagramLayout | null>(`${this.apiUrl}/layout/${seriesId}`);
  }

  saveLayout(seriesId: string, layout: DiagramLayout): Observable<DiagramLayout> {
    return this.http.put<DiagramLayout>(`${this.apiUrl}/layout/${seriesId}`, layout);
  }
}
