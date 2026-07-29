import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { FactCheckFinding, FactCheckVerdict } from '@shared/models/fact-check.model';
import { FactCheckService } from '../fact-check.service';

interface VerdictGroup {
  verdict: FactCheckVerdict;
  label: string;
  icon: string;
  /** One line telling the author what this group means for them. */
  blurb: string;
  findings: FactCheckFinding[];
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

/** Confidence is reported as a word as well as a number, so the badge never
 * relies on colour alone to carry meaning. */
function confidenceLabel(confidence: number): string {
  if (confidence >= 80) return 'High';
  if (confidence >= 50) return 'Medium';
  return 'Low';
}

/**
 * Live report for a chapter fact-check run, shown in the editor's slide-out
 * panel rather than a dialog: the author needs the chapter itself to act on the
 * findings, so nothing here blocks the editor. It shows what stage the run is
 * at, fills in each finding as its web lookup settles, and can stop the run
 * mid-flight — findings already in hand stay on screen.
 */
@Component({
  selector: 'app-fact-check-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, MatProgressBarModule],
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
                <span class="progress-title">Reading the chapter for checkable claims…</span>
                <span class="progress-sub">This part takes a few seconds.</span>
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
          @if (factCheck.stage() === 'checking' && factCheck.webCheckTotal() > 0) {
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

      @if (factCheck.stopped() && findings().length > 0) {
        <p class="notice" role="note">
          <mat-icon aria-hidden="true">stop_circle</mat-icon>
          Stopped after {{ findings().length }} of {{ factCheck.total() }}
          {{ factCheck.total() === 1 ? 'claim' : 'claims' }}. What was checked is below.
        </p>
      }

      @if (isFinished() && findings().length === 0 && !factCheck.error()) {
        <p class="intro">
          @if (factCheck.stopped()) {
            Stopped before any claim was checked.
          } @else {
            No real-world claims were found in this chapter — nothing here to fact-check.
          }
        </p>
      }

      @if (findings().length > 0) {
        @if (isFinished()) {
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

          @if (factCheck.truncated()) {
            <p class="notice" role="note">
              <mat-icon aria-hidden="true">content_cut</mat-icon>
              This chapter is long, so only its opening portion was checked.
            </p>
          }
        }

        <!-- Verdict filters: counts double as show/hide toggles. -->
        <div class="filters" role="group" aria-label="Filter findings by verdict">
          @for (group of groups(); track group.verdict) {
            <button type="button" class="filter-chip" [class]="'filter-chip--' + group.verdict"
                    [class.filter-chip--off]="!shown().has(group.verdict)"
                    [attr.aria-pressed]="shown().has(group.verdict)"
                    (click)="toggle(group.verdict)">
              <mat-icon aria-hidden="true">{{ group.icon }}</mat-icon>
              {{ group.findings.length }} {{ group.label }}
            </button>
          }
        </div>

        @for (group of visibleGroups(); track group.verdict) {
          <div class="section-header" [class]="'section-header--' + group.verdict">
            <mat-icon aria-hidden="true">{{ group.icon }}</mat-icon>
            <h3>{{ group.label }} ({{ group.findings.length }})</h3>
          </div>
          <p class="section-blurb">{{ group.blurb }}</p>

          @for (finding of group.findings; track finding.id) {
            <div class="finding" [class]="'finding--' + finding.verdict">
              <div class="finding-head">
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
          <p class="intro">All verdicts are hidden — turn one back on above to see findings.</p>
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
    .filter-chip--off {
      color: var(--mat-sys-on-surface-variant, #49454f);
      text-decoration: line-through;
    }
    .section-header {
      display: flex; align-items: center; gap: 8px; margin: 20px 0 2px;
      mat-icon { font-size: 20px; width: 20px; height: 20px; }
      h3 { margin: 0; font-size: 0.95rem; font-weight: 600; }
      &:first-of-type { margin-top: 0; }
    }
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
    .finding-head {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
      flex-wrap: wrap;
    }
    .finding-claim { margin: 0; font-weight: 600; font-size: 0.9rem; flex: 1; min-width: 200px; }
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
  /** Public so the template can read the live run state. */
  readonly factCheck = inject(FactCheckService);

  /** Which verdict groups are currently expanded. All start visible. */
  private shownVerdicts = signal<ReadonlySet<FactCheckVerdict>>(new Set(VERDICT_ORDER));
  readonly shown = this.shownVerdicts.asReadonly();
  copied = signal(false);

  readonly findings = this.factCheck.sortedFindings;
  readonly isFinished = computed(() => this.factCheck.stage() === 'done');

  /** 1-based number of the web double-check currently in flight. */
  readonly nextWebCheckNumber = computed(() =>
    Math.min(this.factCheck.webChecked() + 1, this.factCheck.webCheckTotal()),
  );

  /** Every non-empty verdict group, in report order. */
  groups = computed<VerdictGroup[]>(() => {
    const findings = this.findings();
    return VERDICT_ORDER
      .map(verdict => ({
        verdict,
        ...VERDICT_META[verdict],
        findings: findings.filter(f => f.verdict === verdict),
      }))
      .filter(g => g.findings.length > 0);
  });

  visibleGroups = computed(() => this.groups().filter(g => this.shownVerdicts().has(g.verdict)));

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

  label(confidence: number): string {
    return confidenceLabel(confidence);
  }

  confidenceClass(confidence: number): string {
    return confidenceLabel(confidence).toLowerCase();
  }

  /** Copies the whole report as markdown, so it can be pasted into notes. */
  copyReport(): void {
    const lines: string[] = ['# Fact check'];
    if (this.factCheck.truncated()) lines.push('_Only the opening portion of this chapter was checked._');
    if (this.factCheck.stopped()) lines.push('_The check was stopped early; this is a partial report._');
    for (const group of this.groups()) {
      lines.push('', `## ${group.label} (${group.findings.length})`);
      for (const f of group.findings) {
        lines.push('', `### ${f.claim}`);
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
