import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { FactCheckReport, SavedFactCheckFinding } from '@shared/models/fact-check.model';

/** A finished run as the client submits it — the server assigns the id and the
 * container's document type. */
export type FactCheckRunToSave = Omit<FactCheckReport, 'id' | 'docType'>;

const BASE = '/api/fact-check-reports';

/**
 * The durable half of the fact-check feature. `FactCheckService` drives a live
 * run and forgets it; this keeps finished runs, one saved report per run, and
 * tracks which findings the author has worked through.
 *
 * State lives here rather than in the panel so that closing the report and
 * reopening it later — or navigating away and back — lands on the same report
 * at the same scroll of triage, instead of an empty panel.
 */
@Injectable({ providedIn: 'root' })
export class FactCheckReportService {
  private http = inject(HttpClient);

  /** Saved reports for the chapter currently loaded, newest run first. */
  readonly reports = signal<FactCheckReport[]>([]);
  /** Which saved report the panel is showing, if any. */
  readonly selectedId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /** The chapter `reports` belongs to; guards against showing one chapter's
   * reports while another chapter's editor is on screen. */
  private loadedChapterId: string | null = null;

  readonly selected = computed<FactCheckReport | null>(
    () => this.reports().find(r => r.id === this.selectedId()) ?? null,
  );

  readonly hasReports = computed(() => this.reports().length > 0);

  /** Findings still to be dealt with in the selected report. */
  readonly openCount = computed(
    () => this.selected()?.findings.filter(f => !f.resolved).length ?? 0,
  );

  /** Unresolved findings that contradict established fact — the real to-do
   * list, and what the panel's summary line leads with. */
  readonly openDisputedCount = computed(
    () => this.selected()?.findings.filter(f => !f.resolved && f.verdict === 'disputed').length ?? 0,
  );

  /**
   * Loads a chapter's saved reports and selects the newest. A repeat call for
   * the same chapter is a no-op unless `force` is set, so opening the panel
   * doesn't refetch and lose the author's place.
   */
  async load(chapterId: string, force = false): Promise<void> {
    if (!force && this.loadedChapterId === chapterId) return;
    // Moving to a different chapter clears the old one's reports up front, so
    // the panel can't show the previous chapter's findings while this loads.
    if (this.loadedChapterId !== chapterId) {
      this.reports.set([]);
      this.selectedId.set(null);
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const reports = await firstValueFrom(
        this.http.get<FactCheckReport[]>(`${BASE}/chapter/${encodeURIComponent(chapterId)}`),
      );
      this.loadedChapterId = chapterId;
      this.reports.set(reports);
      // Keep the author's selection across a refresh when it still exists.
      if (!reports.some(r => r.id === this.selectedId())) {
        this.selectedId.set(reports[0]?.id ?? null);
      }
    } catch {
      this.error.set('Could not load saved fact checks.');
    } finally {
      this.loading.set(false);
    }
  }

  select(reportId: string | null): void {
    this.selectedId.set(reportId);
  }

  /**
   * Saves a finished run as a new report and selects it, so the panel switches
   * straight from the live stream to the saved, checkable version of the same
   * findings. Returns null when the save failed — the caller keeps showing the
   * live report rather than pretending it was kept.
   */
  async saveRun(report: FactCheckRunToSave): Promise<FactCheckReport | null> {
    this.saving.set(true);
    this.error.set(null);
    try {
      const saved = await firstValueFrom(this.http.post<FactCheckReport>(BASE, report));
      this.loadedChapterId = report.chapterId;
      this.reports.update(list => [saved, ...list]);
      this.selectedId.set(saved.id);
      return saved;
    } catch {
      this.error.set('The fact check could not be saved.');
      return null;
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Ticks a finding off, or puts it back on the list. The local copy flips
   * first so the checkbox responds immediately, and rolls back if the write
   * fails — a tick that silently didn't persist is worse than no tick.
   */
  async setResolved(reportId: string, findingId: string, resolved: boolean): Promise<void> {
    const report = this.reports().find(r => r.id === reportId);
    if (!report) return;
    const previous = report.findings.find(f => f.id === findingId);
    if (!previous) return;

    this.patchFinding(reportId, findingId, {
      resolved,
      resolvedAt: resolved ? new Date().toISOString() : undefined,
    });
    try {
      await firstValueFrom(
        this.http.patch<FactCheckReport>(
          `${BASE}/${encodeURIComponent(reportId)}/findings/${encodeURIComponent(findingId)}`,
          { chapterId: report.chapterId, resolved },
        ),
      );
    } catch {
      this.patchFinding(reportId, findingId, {
        resolved: previous.resolved,
        resolvedAt: previous.resolvedAt,
      });
      this.error.set('That change could not be saved — please try again.');
    }
  }

  /** Deletes a saved report, falling back to the next newest in the panel. */
  async remove(reportId: string): Promise<void> {
    const report = this.reports().find(r => r.id === reportId);
    if (!report) return;
    try {
      await firstValueFrom(
        this.http.delete<void>(`${BASE}/${encodeURIComponent(reportId)}`, {
          params: { chapterId: report.chapterId },
        }),
      );
      const remaining = this.reports().filter(r => r.id !== reportId);
      this.reports.set(remaining);
      if (this.selectedId() === reportId) this.selectedId.set(remaining[0]?.id ?? null);
    } catch {
      this.error.set('That report could not be deleted.');
    }
  }

  /** Clears state when the editor moves to a different chapter. */
  reset(): void {
    this.loadedChapterId = null;
    this.reports.set([]);
    this.selectedId.set(null);
    this.error.set(null);
  }

  dismissError(): void {
    this.error.set(null);
  }

  private patchFinding(
    reportId: string,
    findingId: string,
    patch: Partial<SavedFactCheckFinding>,
  ): void {
    this.reports.update(list =>
      list.map(r =>
        r.id !== reportId
          ? r
          : { ...r, findings: r.findings.map(f => (f.id === findingId ? { ...f, ...patch } : f)) },
      ),
    );
  }
}
