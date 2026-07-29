import { Injectable, computed, inject, signal } from '@angular/core';
import { FactCheckFinding, FactCheckStreamEvent, FactCheckVerdict } from '@shared/models/fact-check.model';
import { AuthFetchService } from '@app/core/services/auth-fetch.service';

/** Where a run has got to. `checking` covers the per-claim web lookups. */
export type FactCheckStage = 'idle' | 'extracting' | 'checking' | 'done';

/** Report order: the author's to-do list first. */
const VERDICT_RANK: Record<FactCheckVerdict, number> = {
  disputed: 0,
  unverifiable: 1,
  verified: 2,
};

/**
 * Drives a chapter fact check: streams findings over SSE and exposes the run's
 * live state as signals so the report can fill in while the check is still
 * working. Findings are ephemeral — a new run replaces the previous list.
 *
 * Findings arrive in completion order (a slow web lookup lands after a fast
 * one), so ordering for display happens here rather than on the server.
 */
@Injectable({ providedIn: 'root' })
export class FactCheckService {
  private readonly authFetchService = inject(AuthFetchService);

  readonly stage = signal<FactCheckStage>('idle');
  readonly findings = signal<FactCheckFinding[]>([]);
  readonly error = signal<string | null>(null);
  /** Claims the run expects to report; 0 until extraction finishes. */
  readonly total = signal(0);
  /** How many claims are going out for a web double-check: the ones the model
   * wasn't confident about. The rest are settled the moment they arrive. */
  readonly webCheckTotal = signal(0);
  readonly truncated = signal(false);
  readonly searchAvailable = signal(false);
  /** True when the author stopped the run before it finished. */
  readonly stopped = signal(false);

  readonly running = computed(() => this.stage() === 'extracting' || this.stage() === 'checking');
  /** How many claims have been reported so far. */
  readonly completed = computed(() => this.findings().length);
  readonly groundedCount = computed(() => this.findings().filter(f => f.grounded).length);

  /** Findings in report order: disputed, then unverifiable, then verified. */
  readonly sortedFindings = computed(() =>
    [...this.findings()].sort(
      (a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.confidence - a.confidence,
    ),
  );

  /** Web double-checks settled so far. The confident findings all arrive in one
   * batch up front, so anything after that batch is a completed lookup. */
  readonly webChecked = computed(() =>
    Math.max(0, this.completed() - (this.total() - this.webCheckTotal())),
  );

  /**
   * Progress 0-100 over the web double-checks, which are the only slow part of a
   * run — tracking it over all claims would jump most of the way instantly and
   * then crawl. Zero while the chapter is still being read.
   */
  readonly percentComplete = computed(() => {
    const webTotal = this.webCheckTotal();
    if (webTotal > 0) return Math.round((this.webChecked() / webTotal) * 100);
    return this.total() > 0 ? 100 : 0;
  });

  private abortController: AbortController | null = null;

  /**
   * Starts a run, streaming findings into `findings()` as they settle.
   * Resolves when the stream completes, errors, or is stopped.
   */
  async run(text: string, knownEntityNames: string[] = []): Promise<void> {
    if (this.running()) return;
    this.reset();
    this.stage.set('extracting');
    this.abortController = new AbortController();

    try {
      const res = await this.authFetchService.fetch('/api/fact-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, knownEntityNames }),
        signal: this.abortController.signal,
      });

      if (!res.ok || !res.body) {
        this.error.set('The fact check could not be started.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleLine = (line: string): void => {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          this.applyEvent(JSON.parse(data) as FactCheckStreamEvent);
        } catch {
          // Skip a malformed SSE chunk.
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      }

      // Flush a final line that arrived without a trailing newline.
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
    } catch (err: unknown) {
      // An abort is the author pressing Stop, not a failure.
      if (err instanceof Error && err.name !== 'AbortError') {
        this.error.set('Could not reach the fact checker.');
      }
    } finally {
      this.abortController = null;
      this.stage.set('done');
    }
  }

  /** Stops an in-flight run, keeping whatever findings already arrived. */
  stop(): void {
    if (!this.running()) return;
    this.stopped.set(true);
    this.abortController?.abort();
    this.abortController = null;
    this.stage.set('done');
  }

  /** Aborts any run and clears the report. */
  reset(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.stage.set('idle');
    this.findings.set([]);
    this.error.set(null);
    this.total.set(0);
    this.webCheckTotal.set(0);
    this.truncated.set(false);
    this.searchAvailable.set(false);
    this.stopped.set(false);
  }

  private applyEvent(event: FactCheckStreamEvent): void {
    if ('error' in event) {
      this.error.set(event.error);
      return;
    }
    if ('finding' in event) {
      this.findings.update(list => [...list, event.finding]);
      return;
    }
    if (event.stage === 'checking') {
      this.total.set(event.total);
      this.webCheckTotal.set(event.webCheckCount);
      this.truncated.set(event.truncated);
      this.searchAvailable.set(event.searchAvailable);
    }
    this.stage.set(event.stage);
  }
}
