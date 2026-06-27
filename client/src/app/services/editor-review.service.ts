import { Injectable, signal, computed, inject } from '@angular/core';
import { EditorReviewBlock, EditorSuggestion, SuggestionSeverity } from '@shared/models';
import { AuthFetchService } from './auth-fetch.service';

/** Resolution state of a streamed suggestion, tracked client-side only. */
export type ReviewStatus = 'open' | 'accepted' | 'rejected';

/** A streamed suggestion plus its local accept/reject state. */
export interface ReviewSuggestion extends EditorSuggestion {
  status: ReviewStatus;
}

/**
 * Drives the "Quill Editor" review: streams editorial suggestions for a chapter
 * over SSE and tracks their accept/reject state. Suggestions are ephemeral —
 * nothing is persisted; a new run replaces the previous list.
 *
 * Severity filtering (hiding `low`) and the actual DOM edits live in the host
 * component, which owns the editor; this service is purely the data layer.
 */
@Injectable({ providedIn: 'root' })
export class EditorReviewService {
  readonly running = signal(false);
  readonly suggestions = signal<ReviewSuggestion[]>([]);
  readonly error = signal<string | null>(null);
  private readonly authFetchService = inject(AuthFetchService);

  /** True once a run has produced suggestions still awaiting a decision. */
  readonly hasOpenSuggestions = computed(() =>
    this.suggestions().some(s => s.status === 'open'),
  );

  private abortController: AbortController | null = null;

  /** Chapter id for which an editorial pass should auto-run once its editor
   *  loads. Set by the "edit_chapter" chat tool (cross-component), consumed by
   *  the chapter editor on load so a fresh navigation kicks off the review. */
  private readonly _autoRunChapterId = signal<string | null>(null);

  /** Requests that the Quill Editor pass auto-run when `chapterId` next loads. */
  requestAutoRun(chapterId: string): void {
    this._autoRunChapterId.set(chapterId);
  }

  /** Returns true (once) if an auto-run was requested for `chapterId`, clearing
   *  the request so it doesn't fire again on subsequent loads. */
  consumeAutoRun(chapterId: string): boolean {
    if (this._autoRunChapterId() === chapterId) {
      this._autoRunChapterId.set(null);
      return true;
    }
    return false;
  }

  /** Suggestions filtered by a minimum severity, newest decisions preserved. */
  visible(showLow: boolean): ReviewSuggestion[] {
    const list = this.suggestions();
    return showLow ? list : list.filter(s => s.severity !== 'low');
  }

  /** Count of still-open suggestions at or above the visible severity. */
  openCount(showLow: boolean): number {
    return this.visible(showLow).filter(s => s.status === 'open').length;
  }

  /** Starts a review run, streaming suggestions into `suggestions()` as they
   *  arrive. Resolves when the stream completes (or errors). */
  async run(chapterId: string, blocks: EditorReviewBlock[]): Promise<void> {
    if (this.running()) return;
    this.cancel();
    this.suggestions.set([]);
    this.error.set(null);
    this.running.set(true);
    this.abortController = new AbortController();

    try {
      const res = await this.authFetch('/api/chapter-editor-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterId, blocks }),
        signal: this.abortController.signal,
      });

      if (!res.ok || !res.body) {
        this.error.set('Failed to start the review.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as { suggestion?: EditorSuggestion; error?: string };
            if (parsed.error) {
              this.error.set(parsed.error);
            } else if (parsed.suggestion) {
              this.suggestions.update(list => [...list, { ...parsed.suggestion!, status: 'open' }]);
            }
          } catch {
            // Skip malformed SSE chunk.
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        this.error.set('Could not connect to the AI editor.');
      }
    } finally {
      this.running.set(false);
      this.abortController = null;
    }
  }

  /** Re-works a single suggestion per a free-form author instruction. Returns
   *  the revised fields (the anchor stays fixed) or null on failure. */
  async refineSuggestion(payload: {
    chapterId: string;
    blockText: string;
    originalText: string;
    currentReplacement: string;
    reason: string;
    instruction: string;
    category?: string;
    severity?: string;
  }): Promise<Partial<EditorSuggestion> | null> {
    try {
      const res = await this.authFetch('/api/chapter-editor-review/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return null;
      const data = await res.json() as { suggestion?: Partial<EditorSuggestion> };
      return data.suggestion ?? null;
    } catch {
      return null;
    }
  }

  /** Merges revised fields into an existing suggestion (keeping its id/anchor). */
  updateSuggestion(id: string, fields: Partial<EditorSuggestion>): void {
    this.suggestions.update(list =>
      list.map(s => (s.id === id ? { ...s, ...fields, id: s.id, blockIndex: s.blockIndex, originalText: s.originalText } : s)),
    );
  }

  /** Marks a suggestion accepted (the host applies the actual edit). */
  markAccepted(id: string): void {
    this.setStatus(id, 'accepted');
  }

  /** Marks a suggestion rejected. */
  markRejected(id: string): void {
    this.setStatus(id, 'rejected');
  }

  /** Re-opens a previously accepted/rejected suggestion (undo). */
  markOpen(id: string): void {
    this.setStatus(id, 'open');
  }

  /** Clears all suggestions and aborts any in-flight run. */
  clear(): void {
    this.cancel();
    this.suggestions.set([]);
    this.error.set(null);
  }

  /** Aborts an in-flight stream without clearing already-received suggestions. */
  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.running.set(false);
  }

  private setStatus(id: string, status: ReviewStatus): void {
    this.suggestions.update(list => list.map(s => (s.id === id ? { ...s, status } : s)));
  }

  private authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    return this.authFetchService.fetch(input, init);
  }
}

/** Re-exported for templates that group cards by severity badge color. */
export type { SuggestionSeverity };
