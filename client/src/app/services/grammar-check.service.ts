import { Injectable, inject } from '@angular/core';
import { AuthFetchService } from './auth-fetch.service';

export interface GrammarError {
  text: string;
  suggestion: string;
  message: string;
}

export interface SuggestedEntity {
  name: string;
  type: 'PERSON' | 'PLACE' | 'THING';
  description: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  title?: string;
}

@Injectable({ providedIn: 'root' })
export class GrammarCheckService {
  private readonly authFetchService = inject(AuthFetchService);

  private authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    return this.authFetchService.fetch(input, init);
  }

  async check(text: string, knownEntityNames: string[] = [], signal?: AbortSignal): Promise<{ errors: GrammarError[]; suggestedEntities: SuggestedEntity[] }> {
    try {
      const response = await this.authFetch('/api/grammar/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, knownEntityNames }),
        signal,
      });
      if (!response.ok) return { errors: [], suggestedEntities: [] };
      const data = await response.json() as { errors: GrammarError[]; suggestedEntities: SuggestedEntity[] };
      return {
        errors: Array.isArray(data.errors) ? data.errors : [],
        suggestedEntities: Array.isArray(data.suggestedEntities) ? data.suggestedEntities : [],
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { errors: [], suggestedEntities: [] };
      return { errors: [], suggestedEntities: [] };
    }
  }

  /**
   * Extracts visible text from the editor, returning only the last 2
   * complete sentences (ending in . ! or ?) for grammar / entity checking.
   * Incomplete sentences (currently being typed) are excluded.
   */
  extractCheckableText(editorEl: HTMLElement): string {
    const fullText = editorEl.innerText ?? '';
    // Split into individual sentences (keep the delimiter attached)
    const sentences = fullText.match(/[^.!?]*[.!?]['"»\u201d\u2019]?/g);
    if (!sentences || sentences.length === 0) return '';
    return sentences.slice(-2).map(s => s.trim()).filter(s => s.length > 0).join(' ');
  }
}
