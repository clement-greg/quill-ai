import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { GenerationCancelResult, GenerationQueueStatus } from '@shared/models/generation-queue.model';

@Injectable({ providedIn: 'root' })
export class GenerationQueueService {
  private http = inject(HttpClient);

  getStatus(): Observable<GenerationQueueStatus> {
    return this.http.get<GenerationQueueStatus>('/api/upload/generation-queue');
  }

  cancel(promptId: string): Observable<GenerationCancelResult> {
    return this.http.delete<GenerationCancelResult>(
      `/api/upload/generation-queue/${encodeURIComponent(promptId)}`,
    );
  }
}
