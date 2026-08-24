import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { GenerationCancelResult, GenerationQueueStatus } from '@shared/models/generation-queue.model';
import { TrackedGenerationJob } from '@shared/models/generation-job.model';

@Injectable({ providedIn: 'root' })
export class GenerationQueueService {
  private http = inject(HttpClient);

  getStatus(): Observable<GenerationQueueStatus> {
    return this.http.get<GenerationQueueStatus>('/api/upload/generation-queue');
  }

  /**
   * The jobs this server queued for the user and what became of each. Unlike
   * getStatus() this is Quill's own record, so it covers jobs that have already
   * left the receiver's queue — including whether their assets were collected.
   */
  getTrackedJobs(): Observable<{ jobs: TrackedGenerationJob[] }> {
    return this.http.get<{ jobs: TrackedGenerationJob[] }>('/api/upload/generation-jobs');
  }

  /** Stops waiting on a job. Anything still running on the receiver keeps going. */
  dismissTrackedJob(promptId: string): Observable<void> {
    return this.http.delete<void>(
      `/api/upload/generation-jobs/${encodeURIComponent(promptId)}`,
    );
  }

  cancel(promptId: string): Observable<GenerationCancelResult> {
    return this.http.delete<GenerationCancelResult>(
      `/api/upload/generation-queue/${encodeURIComponent(promptId)}`,
    );
  }
}
