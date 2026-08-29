import { Component, inject, signal, computed, input, effect, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import {
  FactCheckReport, FactCheckVerdict, SavedFactCheckFinding,
} from '@shared/models/fact-check.model';
import { FactCheckService } from '../fact-check.service';
import { FactCheckReportService } from '../fact-check-report.service';

interface VerdictGroup {
  verdict: FactCheckVerdict;
  label: string;
  icon: string;
  /** One line telling the author what this group means for them. */
  blurb: string;
  findings: SavedFactCheckFinding[];
  /** How many of the group's findings the author has checked off. */
  doneCount: number;
}

const VERDICT_META: Record<FactCheckVerdict, { label: string; icon: string; blurb: string }> = {
  disputed: {
    label: 'Disputed',
    icon: 'error',
    blurb: 'These contradict established fact. Each one has a suggested fix.',
  },
  unverifiable: {
    label: 'Needs checking',
    icon: 'help',
    blurb: "Real-world claims that couldn't be settled — worth your own look.",
  },
  verified: {
    label: 'Verified',
    icon: 'check_circle',
    blurb: 'These hold up against established fact.',
  },
};

const VERDICT_ORDER: readonly FactCheckVerdict[] = ['disputed', 'unverifiable', 'verified'];

/** Report order: the author's to-do list first. */
const VERDICT_RANK: Record<FactCheckVerdict, number> = {
  disputed: 0,
  unverifiable: 1,
  verified: 2,
};

/** Confidence is reported as a word as well as a number, so the badge never
 * relies on colour alone to carry meaning. */
function confidenceLabel(confidence: number): string {
  if (confidence >= 80) return 'High';
  if (confidence >= 50) return 'Medium';
  return 'Low';
}

/**
 * Report for a chapter fact check, shown in the editor's slide-out panel rather
 * than a dialog: the author needs the chapter itself to act on the findings, so
 * nothing here blocks the editor.
 *
 * The panel has two faces. While a run streams it shows live progress and fills
 * in each finding as its lookup settles. Once the run is saved — and whenever
 * the author reopens an earlier run from the picker — it shows a saved report,
 * where every finding carries a checkbox: the author ticks each one off as they
 * either correct the prose or decide they're content to leave it as written.
 */
@Component({
  selector: 'app-fact-check-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe, MatButtonModule, MatIconModule, MatTooltipModule, MatCheckboxModule,
    MatProgressBarModule,
  ],
  template: `
    <div class="panel-header">
      <mat-icon aria-hidden="true">fact_check</mat-icon>
      <h2>Fact Check</h2>
      @if (!factCheck.running() && findings().length > 0) {
        <button mat-button type="button" class="copy-btn" (click)="copyReport()">
          <mat-icon>{{ copied() ? 'check' : 'content_copy' }}</mat-icon>
          {{ copied() ? 'Copied' : 'Copy report' }}
        </button>
      }
    </div>
    <div class="panel-body">

      @if (factCheck.running()) {
        <!-- ── Working state: what's happening, how far along, and a way out ── -->
        <div class="progress-panel" role="status" aria-live="polite">
          <div class="progress-head">
            <mat-icon class="progress-icon">
              {{ factCheck.stage() === 'extracting' ? 'auto_stories' : 'travel_explore' }}
            </mat-icon>
            <div class="progress-text">
              @if (factCheck.stage() === 'extracting') {
                @if (factCheck.segmentsTotal() > 1) {
                  <!-- Parts are read side by side, so report how many are done
                       rather than naming "the current part", which would suggest
                       a sequential walk through the chapter. -->
                  <span class="progress-title">
                    Reading the chapter for checkable claims —
                    {{ factCheck.segmentsDone() }} of {{ factCheck.segmentsTotal() }} parts done
                  </span>
                  <span class="progress-sub">
                    This chapter is long, so it's being read in
                    {{ factCheck.segmentsTotal() }} parts at once — all of it gets checked.
                  </span>
                } @else {
                  <span class="progress-title">Reading the chapter for checkable claims…</span>
                  <span class="progress-sub">This part takes a few seconds.</span>
                }
              } @else if (factCheck.webCheckTotal() > 0) {
                <span class="progress-title">
                  Double-checking claim {{ nextWebCheckNumber() }} of
                  {{ factCheck.webCheckTotal() }} on the web
                </span>
                <span class="progress-sub">
                  {{ factCheck.total() - factCheck.webCheckTotal() }} of
                  {{ factCheck.total() }} claims were settled confidently — only the rest are
                  being searched.
                </span>
              } @else {
                <span class="progress-title">Settling {{ factCheck.total() }} claims…</span>
                <span class="progress-sub">No claim needed a web double-check.</span>
              }
            </div>
            <button mat-stroked-button type="button" class="stop-btn" (click)="stop()">
              <mat-icon>stop_circle</mat-icon>
              Stop
            </button>
          </div>
          @if (factCheck.stage() === 'extracting' && factCheck.segmentsTotal() > 1) {
            <mat-progress-bar mode="determinate" [value]="readPercent()"
              [attr.aria-label]="'Parts read: ' + factCheck.segmentsDone() + ' of ' + factCheck.segmentsTotal()" />
          } @else if (factCheck.stage() === 'checking' && factCheck.webCheckTotal() > 0) {
            <mat-progress-bar mode="determinate" [value]="factCheck.percentComplete()"
              [attr.aria-label]="'Web double-checks done: ' + factCheck.webChecked() + ' of ' + factCheck.webCheckTotal()" />
          } @else {
            <mat-progress-bar mode="indeterminate" aria-label="Reading the chapter" />
          }
        </div>
      }

      @if (factCheck.error()) {
        <p class="notice notice--error" role="alert">
          <mat-icon aria-hidden="true">error</mat-icon>
          {{ factCheck.error() }}
        </p>
      }
      @if (saved.error(); as saveError) {
        <p class="notice notice--error" role="alert">
          <mat-icon aria-hidden="true">error</mat-icon>
          {{ saveError }}
          <button mat-button type="button" (click)="saved.dismissError()">Dismiss</button>
        </p>
      }

      <!-- ── Saved-run picker: every past check on this chapter ── -->
      @if (!showLive() && saved.hasReports()) {
        <div class="runs">
          <label class="runs-label" for="fc-run-select">Saved checks</label>
          <div class="runs-row">
            <select id="fc-run-select" class="runs-select" [value]="saved.selectedId() ?? ''"
                    (change)="onSelectRun($event)">
              @for (report of saved.reports(); track report.id) {
                <option [value]="report.id">
                  {{ report.runAt | date: 'MMM d, y, h:mm a' }} —
                  {{ report.findings.length }}
                  {{ report.findings.length === 1 ? 'claim' : 'claims' }}{{ doneSuffix(report) }}
                </option>
              }
            </select>
            <button mat-icon-button type="button" class="run-delete"
                    matTooltip="Delete this saved check"
                    aria-label="Delete this saved check"
                    (click)="deleteSelected()">
              <mat-icon>delete_outline</mat-icon>
            </button>
          </div>
          @if (saved.selected(); as report) {
            <p class="runs-progress">
              @if (saved.openCount() === 0) {
                <mat-icon aria-hidden="true" class="runs-done-icon">task_alt</mat-icon>
                All {{ report.findings.length }}
                {{ report.findings.length === 1 ? 'finding' : 'findings' }} checked off.
              } @else {
                {{ report.findings.length - saved.openCount() }} of {{ report.findings.length }}
                checked off
                @if (saved.openDisputedCount() > 0) {
                  · {{ saved.openDisputedCount() }} disputed still open
                }
              }
            </p>
          }
        </div>
      }

      @if (saved.loading()) {
        <p class="intro">Loading saved fact checks…</p>
      }

      @if (isFinished() && findings().length === 0 && !factCheck.error() && !saved.loading()) {
        <p class="intro">
          @if (showLive() && factCheck.stopped()) {
            Stopped before any claim was checked.
          } @else if (showLive()) {
            No real-world claims were found in this chapter — nothing here to fact-check.
          } @else if (!saved.hasReports()) {
            No fact check has been saved for this chapter yet. Run one from the chapter menu
            and its findings will be kept here for you to work through.
          }
        </p>
      }

      @if (showLive() && factCheck.stopped() && findings().length > 0) {
        <p class="notice" role="note">
          <mat-icon aria-hidden="true">stop_circle</mat-icon>
          Stopped after {{ findings().length }} of {{ factCheck.total() }}
          {{ factCheck.total() === 1 ? 'claim' : 'claims' }}. What was checked is below.
        </p>
      }

      @if (findings().length > 0) {
        @if (isFinished()) {
          @if (showLive()) {
            <p class="intro">
              {{ findings().length }} checkable
              {{ findings().length === 1 ? 'claim' : 'claims' }} reported.
              @if (factCheck.groundedCount() > 0) {
                The model was unsure of {{ factCheck.groundedCount() }} of them, so
                {{ factCheck.groundedCount() === 1 ? 'it was' : 'those were' }} double-checked
                against live web sources, linked below.
                @if (factCheck.groundedCount() < findings().length) {
                  The rest it answered confidently on its own.
                }
              } @else if (factCheck.webCheckTotal() > 0) {
                Web search wasn't reachable for this run, so these come from the model's own
                knowledge.
              } @else if (factCheck.searchAvailable()) {
                The model answered every one of them confidently, so none needed a web
                double-check.
              } @else {
                These come from the model's own knowledge — web search isn't configured on the
                server.
              }
              Treat the confidence level on each finding as part of the finding.
            </p>
          }

          @if (truncated()) {
            <p class="notice" role="note">
              <mat-icon aria-hidden="true">content_cut</mat-icon>
              This chapter ran past even the checker's multi-part limit, so its final section
              wasn't read.
            </p>
          }
          @if (!showLive() && stopped()) {
            <p class="notice" role="note">
              <mat-icon aria-hidden="true">stop_circle</mat-icon>
              This check was stopped early, so it covers only part of the chapter.
            </p>
          }
        }

        <!-- Verdict filters: counts double as show/hide toggles. -->
        <div class="filters" role="group" aria-label="Filter findings">
          @for (group of groups(); track group.verdict) {
            <button type="button" class="filter-chip" [class]="'filter-chip--' + group.verdict"
                    [class.filter-chip--off]="!shown().has(group.verdict)"
                    [attr.aria-pressed]="shown().has(group.verdict)"
                    (click)="toggle(group.verdict)">
              <mat-icon aria-hidden="true">{{ group.icon }}</mat-icon>
              {{ group.findings.length }} {{ group.label }}
            </button>
          }
          @if (checkable() && doneCount() > 0) {
            <button type="button" class="filter-chip filter-chip--done"
                    [class.filter-chip--off]="hideDone()"
                    [attr.aria-pressed]="!hideDone()"
                    (click)="hideDone.set(!hideDone())">
              <mat-icon aria-hidden="true">{{ hideDone() ? 'visibility_off' : 'task_alt' }}</mat-icon>
              {{ hideDone() ? 'Showing open only' : doneCount() + ' checked off' }}
            </button>
          }
        </div>

        @for (group of visibleGroups(); track group.verdict) {
          <div class="section-header" [class]="'section-header--' + group.verdict">
            <mat-icon aria-hidden="true">{{ group.icon }}</mat-icon>
            <h3>
              {{ group.label }} ({{ group.findings.length }})
              @if (checkable() && group.doneCount > 0) {
                <span class="section-done">· {{ group.doneCount }} done</span>
              }
            </h3>
          </div>
          <p class="section-blurb">{{ group.blurb }}</p>

          @for (finding of group.findings; track finding.id) {
            <div class="finding" [class]="'finding--' + finding.verdict"
                 [class.finding--resolved]="finding.resolved">
              <div class="finding-head">
                @if (checkable()) {
                  <mat-checkbox class="finding-check" [checked]="!!finding.resolved"
                                (change)="setResolved(finding, $event.checked)"
                                [matTooltip]="finding.resolved
                                  ? 'Put this back on the list'
                                  : 'Check off — fixed, or fine as written'"
                                [attr.aria-label]="'Check off: ' + finding.claim" />
                }
                <p class="finding-claim">{{ finding.claim }}</p>
                <span class="confidence" [class]="'confidence--' + confidenceClass(finding.confidence)"
                      [matTooltip]="'How sure the check is of this verdict'">
                  {{ label(finding.confidence) }} confidence · {{ finding.confidence }}%
                </span>
              </div>
              <div class="finding-tags">
                <span class="category-chip">{{ finding.category }}</span>
                @if (finding.grounded) {
                  <span class="source-badge source-badge--web">
                    <mat-icon aria-hidden="true">travel_explore</mat-icon>
                    Checked on the web
                  </span>
                } @else {
                  <span class="source-badge"
                        matTooltip="No web sources for this one — judged from the model's training knowledge">
                    <mat-icon aria-hidden="true">psychology</mat-icon>
                    Model knowledge
                  </span>
                }
                @if (finding.resolved && finding.resolvedAt) {
                  <span class="source-badge source-badge--done">
                    <mat-icon aria-hidden="true">task_alt</mat-icon>
                    Checked off {{ finding.resolvedAt | date: 'MMM d' }}
                  </span>
                }
              </div>
              @if (finding.quote) {
                <p class="finding-quote">&ldquo;{{ finding.quote }}&rdquo;</p>
              }
              <p class="finding-explanation">{{ finding.explanation }}</p>
              @if (finding.sources?.length) {
                <div class="finding-sources">
                  <span class="sources-label">Sources</span>
                  <ul class="sources-list">
                    @for (source of finding.sources; track source.url) {
                      <li>
                        <a [href]="source.url" target="_blank" rel="noopener noreferrer">
                          {{ source.title }}
                          <mat-icon aria-hidden="true">open_in_new</mat-icon>
                        </a>
                      </li>
                    }
                  </ul>
                </div>
              }
              @if (finding.remedy) {
                <div class="finding-remedy">
                  <mat-icon aria-hidden="true">build</mat-icon>
                  <div>
                    <span class="remedy-label">How to fix</span>
                    <p class="remedy-text">{{ finding.remedy }}</p>
                  </div>
                </div>
              }
            </div>
          }
        }

        @if (visibleGroups().length === 0) {
          <p class="intro">
            @if (hideDone() && doneCount() > 0) {
              Everything shown is checked off — turn a filter back on above to see it.
            } @else {
              All verdicts are hidden — turn one back on above to see findings.
            }
          </p>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; box-sizing: border-box; }
    /* The slide-out container owns the scrolling, so the header sticks to the
       scrollport rather than the panel growing its own scroll area. That
       scrollport carries 56px of top padding to clear its close button, so the
       header rises into the gap — otherwise findings scroll through it. */
    .panel-header {
      position: sticky; top: -56px; margin-top: -56px; z-index: 2;
      display: flex; align-items: center; gap: 8px;
      /* Right padding clears the container's close button, which sits top-right. */
      padding: 68px 52px 12px 20px;
      background: var(--mat-sys-surface, #fffbfe);
      border-bottom: 1px solid var(--mat-sys-outline-variant, #cac4d0);
      h2 { margin: 0; font-size: 1.1rem; font-weight: 600; flex: 1; min-width: 0; }
      mat-icon { color: var(--mat-sys-primary, #6750a4); flex-shrink: 0; }
    }
    .copy-btn { flex-shrink: 0; font-size: 0.8rem;
      mat-icon { font-size: 16px; width: 16px; height: 16px; margin-right: 4px; color: inherit; }
    }
    .panel-body { padding: 16px 20px 24px; }
    .intro { margin: 0 0 12px; color: var(--mat-sys-on-surface-variant, #49454f); font-size: 0.9rem; }
    .notice {
      display: flex; align-items: center; gap: 8px; margin: 0 0 12px;
      padding: 8px 10px; border-radius: 8px; font-size: 0.85rem;
      background: var(--mat-sys-surface-variant, #f3edf7);
      mat-icon { font-size: 18px; width: 18px; height: 18px; flex-shrink: 0; }
    }
    .notice--error { background: #f7d9d7; color: #6b1712; }

    /* ── Saved runs ── */
    .runs { margin-bottom: 16px; }
    .runs-label {
      display: block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--mat-sys-on-surface-variant, #49454f);
      margin-bottom: 4px;
    }
    .runs-row { display: flex; align-items: center; gap: 4px; }
    .runs-select {
      flex: 1; min-width: 0; font: inherit; font-size: 0.85rem;
      padding: 6px 8px; border-radius: 6px;
      border: 1px solid var(--mat-sys-outline-variant, #cac4d0);
      background: var(--mat-sys-surface, #fffbfe);
      color: var(--mat-sys-on-surface, #1d1b20);
    }
    .run-delete { flex-shrink: 0; color: var(--mat-sys-on-surface-variant, #49454f); }
    .runs-progress {
      display: flex; align-items: center; gap: 4px;
      margin: 6px 0 0; font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant, #49454f);
    }
    .runs-done-icon { font-size: 16px; width: 16px; height: 16px; color: #1b5e20; }

    /* ── Working state ── */
    .progress-panel {
      margin-bottom: 16px; padding: 12px; border-radius: 8px;
      background: var(--mat-sys-surface-variant, #f3edf7);
    }
    .progress-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
    /* Taller than the 4px default so the run reads as working at a glance. */
    .progress-panel mat-progress-bar {
      --mat-progress-bar-track-height: 8px;
      --mat-progress-bar-active-indicator-height: 8px;
      --mat-progress-bar-track-shape: 4px;
      border-radius: 4px; overflow: hidden;
    }
    .progress-icon {
      flex-shrink: 0; color: var(--mat-sys-primary, #6750a4);
      animation: fc-pulse 1.6s ease-in-out infinite;
    }
    .progress-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .progress-title { font-size: 0.9rem; font-weight: 600; }
    .progress-sub { font-size: 0.8rem; color: var(--mat-sys-on-surface-variant, #49454f); }
    .stop-btn { flex-shrink: 0; color: #b3261e; height: 32px; line-height: 32px; padding: 0 12px;
      mat-icon { font-size: 18px; width: 18px; height: 18px; margin-right: 2px; }
    }

    @keyframes fc-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.9); }
    }
    @keyframes fc-land {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }

    .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .filter-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 12px; border-radius: 16px; cursor: pointer;
      font: inherit; font-size: 0.8rem; font-weight: 600;
      border: 1px solid currentColor; background: transparent;
      mat-icon { font-size: 16px; width: 16px; height: 16px; }
    }
    .filter-chip--disputed { color: #b3261e; }
    .filter-chip--unverifiable { color: #8a5200; }
    .filter-chip--verified { color: #1b5e20; }
    .filter-chip--done { color: var(--mat-sys-primary, #6750a4); }
    .filter-chip--off {
      color: var(--mat-sys-on-surface-variant, #49454f);
      text-decoration: line-through;
    }
    /* "Showing open only" is a live state, not a hidden group, so it keeps its
       colour where the verdict chips grey out. */
    .filter-chip--done.filter-chip--off {
      color: var(--mat-sys-primary, #6750a4); text-decoration: none;
    }
    .section-header {
      display: flex; align-items: center; gap: 8px; margin: 20px 0 2px;
      mat-icon { font-size: 20px; width: 20px; height: 20px; }
      h3 { margin: 0; font-size: 0.95rem; font-weight: 600; }
      &:first-of-type { margin-top: 0; }
    }
    .section-done { font-weight: 500; color: var(--mat-sys-on-surface-variant, #49454f); }
    .section-header--disputed { color: #b3261e; }
    .section-header--unverifiable { color: #8a5200; }
    .section-header--verified { color: #1b5e20; }
    .section-blurb {
      margin: 0 0 10px; font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant, #49454f);
    }
    .finding {
      padding: 10px 12px; border-radius: 8px; margin-bottom: 8px;
      border-left: 3px solid transparent;
      background: var(--mat-sys-surface-variant, #f3edf7);
      /* Each finding is inserted the moment its lookup lands. */
      animation: fc-land 220ms ease-out;
    }
    .finding--disputed { border-left-color: #b3261e; }
    .finding--unverifiable { border-left-color: #8a5200; }
    .finding--verified { border-left-color: #1b5e20; }
    /* A checked-off finding recedes but stays readable — the author may want to
       see what they decided, and un-tick it. */
    .finding--resolved {
      opacity: 0.6;
      .finding-claim { text-decoration: line-through; }
    }
    .finding-head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
      flex-wrap: wrap;
    }
    .finding-check { flex-shrink: 0; margin-left: -8px; }
    .finding-claim { margin: 0; font-weight: 600; font-size: 0.9rem; flex: 1; min-width: 160px; }
    .confidence {
      flex-shrink: 0; padding: 2px 8px; border-radius: 10px;
      font-size: 0.72rem; font-weight: 600; white-space: nowrap;
    }
    .confidence--high { background: #d7f0d9; color: #14471a; }
    .confidence--medium { background: #fdeccb; color: #6b3f00; }
    .confidence--low { background: #f7d9d7; color: #6b1712; }
    .finding-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
    .category-chip {
      padding: 1px 8px; border-radius: 10px; font-size: 0.7rem; font-weight: 600;
      text-transform: capitalize;
      background: var(--mat-sys-secondary-container, #e8def8);
      color: var(--mat-sys-on-secondary-container, #1d192b);
    }
    .source-badge {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 1px 8px 1px 6px; border-radius: 10px; font-size: 0.7rem; font-weight: 600;
      background: var(--mat-sys-surface, #fffbfe);
      color: var(--mat-sys-on-surface-variant, #49454f);
      mat-icon { font-size: 13px; width: 13px; height: 13px; }
    }
    .source-badge--web { background: #d7f0d9; color: #14471a; }
    .source-badge--done { background: #e8def8; color: #1d192b; }
    .finding-sources { margin-top: 10px; }
    .sources-label {
      display: block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--mat-sys-on-surface-variant, #49454f);
    }
    .sources-list {
      margin: 4px 0 0; padding: 0; list-style: none;
      display: flex; flex-direction: column; gap: 2px;
      a {
        display: inline-flex; align-items: center; gap: 3px;
        font-size: 0.8rem; color: var(--mat-sys-primary, #6750a4);
        mat-icon { font-size: 13px; width: 13px; height: 13px; }
      }
    }
    .finding-quote {
      margin: 8px 0 0; padding-left: 10px;
      border-left: 2px solid var(--mat-sys-outline-variant, #cac4d0);
      font-style: italic; font-size: 0.85rem;
      color: var(--mat-sys-on-surface-variant, #49454f);
    }
    .finding-explanation { margin: 8px 0 0; font-size: 0.85rem; }
    .finding-remedy {
      display: flex; align-items: flex-start; gap: 8px;
      margin-top: 10px; padding: 8px 10px; border-radius: 6px;
      background: var(--mat-sys-surface, #fffbfe);
      mat-icon { font-size: 18px; width: 18px; height: 18px; flex-shrink: 0; }
    }
    .remedy-label {
      display: block; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--mat-sys-on-surface-variant, #49454f);
    }
    .remedy-text { margin: 2px 0 0; font-size: 0.85rem; }

    @media (prefers-reduced-motion: reduce) {
      .progress-icon, .finding { animation: none; }
    }
  `],
})
export class FactCheckPanelComponent {
  /** The chapter whose saved reports the panel lists. */
  chapterId = input<string | null>(null);

  /** Public so the template can read the live run state. */
  readonly factCheck = inject(FactCheckService);
  readonly saved = inject(FactCheckReportService);

  /** Which verdict groups are currently expanded. All start visible. */
  private shownVerdicts = signal<ReadonlySet<FactCheckVerdict>>(new Set(VERDICT_ORDER));
  readonly shown = this.shownVerdicts.asReadonly();
  /** Hides findings already checked off, so the panel becomes a to-do list. */
  readonly hideDone = signal(false);
  copied = signal(false);

  /**
   * True while a run is streaming or has finished without being saved. The
   * panel shows the live report then, and the saved report otherwise — a run is
   * saved the moment it finishes, so this is normally brief.
   */
  readonly showLive = computed(() => this.factCheck.stage() !== 'idle');

  /** Check-offs need a saved report to write to, so the live view has none. */
  readonly checkable = computed(() => !this.showLive() && this.saved.selected() !== null);

  /** Findings on show, in report order, from whichever source is current. */
  readonly findings = computed<SavedFactCheckFinding[]>(() => {
    const list: SavedFactCheckFinding[] = this.showLive()
      ? this.factCheck.sortedFindings()
      : (this.saved.selected()?.findings ?? []);
    return [...list].sort(
      (a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.confidence - a.confidence,
    );
  });

  readonly doneCount = computed(() => this.findings().filter(f => f.resolved).length);

  /** Run caveats, read from the live run or the saved report as appropriate. */
  readonly truncated = computed(() =>
    this.showLive() ? this.factCheck.truncated() : (this.saved.selected()?.truncated ?? false),
  );
  readonly stopped = computed(() =>
    this.showLive() ? this.factCheck.stopped() : (this.saved.selected()?.stopped ?? false),
  );

  readonly isFinished = computed(() => !this.showLive() || this.factCheck.stage() === 'done');

  /** Progress through the reading stage of a chapter split into parts. */
  readonly readPercent = computed(() => {
    const total = this.factCheck.segmentsTotal();
    return total > 0 ? Math.round((this.factCheck.segmentsDone() / total) * 100) : 0;
  });

  /** 1-based number of the web double-check currently in flight. */
  readonly nextWebCheckNumber = computed(() =>
    Math.min(this.factCheck.webChecked() + 1, this.factCheck.webCheckTotal()),
  );

  /** Every non-empty verdict group, in report order. */
  groups = computed<VerdictGroup[]>(() => {
    const findings = this.findings();
    const hideDone = this.hideDone();
    return VERDICT_ORDER
      .map(verdict => {
        const all = findings.filter(f => f.verdict === verdict);
        return {
          verdict,
          ...VERDICT_META[verdict],
          findings: hideDone ? all.filter(f => !f.resolved) : all,
          doneCount: all.filter(f => f.resolved).length,
        };
      })
      .filter(g => g.findings.length > 0);
  });

  visibleGroups = computed(() => this.groups().filter(g => this.shownVerdicts().has(g.verdict)));

  constructor() {
    // Saved reports belong to one chapter; load them whenever the panel is
    // pointed at a chapter, and again when the editor navigates to another.
    effect(() => {
      const id = this.chapterId();
      if (id) void this.saved.load(id);
    });
  }

  /** Stops the run but leaves the report open with what it found. */
  stop(): void {
    this.factCheck.stop();
  }

  toggle(verdict: FactCheckVerdict): void {
    this.shownVerdicts.update(current => {
      const next = new Set(current);
      if (!next.delete(verdict)) next.add(verdict);
      return next;
    });
  }

  onSelectRun(event: Event): void {
    this.saved.select((event.target as HTMLSelectElement).value || null);
  }

  deleteSelected(): void {
    const id = this.saved.selectedId();
    if (id) void this.saved.remove(id);
  }

  setResolved(finding: SavedFactCheckFinding, resolved: boolean): void {
    const reportId = this.saved.selectedId();
    if (!reportId) return;
    void this.saved.setResolved(reportId, finding.id, resolved);
  }

  /** " · 2 done", or nothing when a run hasn't been triaged yet. */
  doneSuffix(report: FactCheckReport): string {
    const done = report.findings.filter(f => f.resolved).length;
    return done > 0 ? ` · ${done} done` : '';
  }

  label(confidence: number): string {
    return confidenceLabel(confidence);
  }

  confidenceClass(confidence: number): string {
    return confidenceLabel(confidence).toLowerCase();
  }

  /** Copies the whole report as markdown, so it can be pasted into notes. */
  copyReport(): void {
    const lines: string[] = ['# Fact check'];
    if (this.truncated()) lines.push("_This chapter's final section was too long to read._");
    if (this.stopped()) lines.push('_The check was stopped early; this is a partial report._');
    for (const group of this.groups()) {
      lines.push('', `## ${group.label} (${group.findings.length})`);
      for (const f of group.findings) {
        lines.push('', `### ${this.checkable() ? (f.resolved ? '[x] ' : '[ ] ') : ''}${f.claim}`);
        lines.push(`- Confidence: ${confidenceLabel(f.confidence)} (${f.confidence}%) · ${f.category}`);
        lines.push(`- Basis: ${f.grounded ? 'live web sources' : 'model knowledge only'}`);
        if (f.quote) lines.push(`- Passage: "${f.quote}"`);
        lines.push(`- Assessment: ${f.explanation}`);
        if (f.remedy) lines.push(`- How to fix: ${f.remedy}`);
        for (const source of f.sources ?? []) lines.push(`- Source: [${source.title}](${source.url})`);
      }
    }
    navigator.clipboard.writeText(lines.join('\n')).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      },
      () => this.copied.set(false),
    );
  }
}
