import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_SNACK_BAR_DATA } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { FactCheckService } from '../fact-check.service';

export interface FactCheckToastData {
  /** Opens the full report panel. */
  onView: () => void;
  /** Stops the run, keeping whatever has been checked. */
  onStop: () => void;
}

/**
 * Ambient progress for a fact-check run, shown as a snack bar so the author can
 * keep writing while the check works. Reports the current stage and a live
 * progress bar, and offers the two things worth doing mid-run: open the report,
 * or stop the check.
 */
@Component({
  selector: 'app-fact-check-toast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <!-- No aria-live here: the snack bar container owns the live region, and a
         second one inside its label makes Material's announcer reparent onto
         itself (HierarchyRequestError). The politeness config option covers it. -->
    <div class="toast">
      <div class="toast-row">
        <mat-icon class="toast-icon" aria-hidden="true">
          {{ factCheck.stage() === 'extracting' ? 'auto_stories' : 'travel_explore' }}
        </mat-icon>
        <span class="toast-text">
          @if (factCheck.stage() === 'extracting') {
            Fact check: reading the chapter…
          } @else if (factCheck.stage() === 'checking' && factCheck.webCheckTotal() > 0) {
            Fact check: web double-check {{ nextWebCheckNumber() }} of
            {{ factCheck.webCheckTotal() }}
            @if (disputedCount() > 0) {
              · {{ disputedCount() }} disputed so far
            }
          } @else if (factCheck.stage() === 'checking') {
            Fact check: settling {{ factCheck.total() }} claims…
          } @else {
            Fact check finished.
          }
        </span>
        <div class="toast-actions">
          <button mat-button type="button" class="view-btn" (click)="data.onView()">View</button>
          @if (factCheck.running()) {
            <button mat-button type="button" class="stop-btn" (click)="data.onStop()">Stop</button>
          }
        </div>
      </div>
      @if (factCheck.stage() === 'checking' && factCheck.webCheckTotal() > 0) {
        <mat-progress-bar mode="determinate" [value]="factCheck.percentComplete()"
          [attr.aria-label]="'Web double-checks done: ' + factCheck.webChecked() + ' of ' + factCheck.webCheckTotal()" />
      } @else {
        <mat-progress-bar mode="indeterminate" aria-label="Reading the chapter" />
      }
    </div>
  `,
  styles: [`
    .toast { display: flex; flex-direction: column; gap: 8px; min-width: min(360px, 70vw); }
    .toast-row { display: flex; align-items: center; gap: 8px; }
    .toast-icon {
      flex-shrink: 0; font-size: 20px; width: 20px; height: 20px;
      animation: fct-pulse 1.6s ease-in-out infinite;
    }
    .toast-text { flex: 1; min-width: 0; font-size: 0.85rem; }
    .toast-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    /* Snack bars use an inverted surface, so actions take the accent colour. */
    .view-btn { color: var(--mat-sys-inverse-primary, #d0bcff); }
    .stop-btn { color: var(--mat-sys-inverse-primary, #d0bcff); }
    mat-progress-bar {
      --mat-progress-bar-track-height: 6px;
      --mat-progress-bar-active-indicator-height: 6px;
      border-radius: 3px; overflow: hidden;
    }
    @keyframes fct-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.9); }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast-icon { animation: none; }
    }
  `],
})
export class FactCheckToastComponent {
  readonly data = inject<FactCheckToastData>(MAT_SNACK_BAR_DATA);
  readonly factCheck = inject(FactCheckService);

  /** 1-based number of the web double-check currently in flight. */
  nextWebCheckNumber(): number {
    return Math.min(this.factCheck.webChecked() + 1, this.factCheck.webCheckTotal());
  }

  disputedCount(): number {
    return this.factCheck.findings().filter(f => f.verdict === 'disputed').length;
  }
}
