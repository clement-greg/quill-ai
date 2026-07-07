import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

interface ContentFilterTermsResponse {
  terms: string[];
}

@Injectable({ providedIn: 'root' })
export class ContentFilterService {
  private http = inject(HttpClient);

  private _terms = signal<string[]>([]);
  readonly terms = this._terms.asReadonly();

  async loadFromServer(): Promise<void> {
    try {
      const { terms } = await firstValueFrom(
        this.http.get<ContentFilterTermsResponse>('/api/app-settings/content-filter-terms')
      );
      this._terms.set(terms);
    } catch {
      // Server unavailable — keep the empty default
    }
  }

  private async saveTerms(terms: string[]): Promise<void> {
    this._terms.set(terms);
    await firstValueFrom(
      this.http.put<ContentFilterTermsResponse>('/api/app-settings/content-filter-terms', { terms })
    ).catch(() => {});
  }

  addTerm(term: string): void {
    const trimmed = term.trim();
    if (!trimmed || this._terms().includes(trimmed)) return;
    this.saveTerms([...this._terms(), trimmed]);
  }

  removeTerm(term: string): void {
    this.saveTerms(this._terms().filter(t => t !== term));
  }
}
