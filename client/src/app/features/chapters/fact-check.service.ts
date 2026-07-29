import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { FactCheckRequest, FactCheckResult } from '@shared/models/fact-check.model';

@Injectable({ providedIn: 'root' })
export class FactCheckService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/fact-check';

  /**
   * Fact-checks the real-world claims in a chapter's prose. Nothing is
   * persisted — the report is generated fresh on every run.
   */
  check(text: string, knownEntityNames: string[] = []): Observable<FactCheckResult> {
    return this.http.post<FactCheckResult>(this.apiUrl, { text, knownEntityNames } satisfies FactCheckRequest);
  }
}
