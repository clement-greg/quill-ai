import { ChangeDetectionStrategy, Component, computed, effect, inject, OnDestroy, signal, untracked } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { DialogueTaggingService } from '../dialogue-tagging.service';

/** How long "Speakers updated" stays up after tagging finishes. */
const DONE_MS = 2500;

/**
 * A small chip while saved dialogue is being attributed ("Working out who says
 * each line… 20 of 64"), then "Speakers updated" for a moment. The quotes'
 * colors fill in as each batch lands; this says why they're changing.
 */
@Component({
  selector: 'app-dialogue-tagging-status',
  imports: [MatIconModule, MatProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .dts {
      position: fixed;
      left: 50%;
      bottom: 88px; /* clear of the "Chapter saved" snackbar */
      transform: translateX(-50%);
      z-index: 900;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      background: var(--mat-sys-inverse-surface, #313033);
      color: var(--mat-sys-inverse-on-surface, #f4eff4);
      font-size: 13px;
      box-shadow: 0 2px 8px rgb(0 0 0 / 20%);
      pointer-events: none;
    }
    mat-icon { font-size: 18px; width: 18px; height: 18px; }
  `,
  template: `
    <div role="status" aria-live="polite">
      @if (total() > 0) {
        <div class="dts">
          <mat-spinner diameter="16" strokeWidth="2" aria-hidden="true" />
          Working out who says each line… {{ done() }} of {{ total() }}
        </div>
      } @else if (justFinished()) {
        <div class="dts"><mat-icon aria-hidden="true">check</mat-icon> Speakers updated</div>
      }
    </div>
  `,
})
export class DialogueTaggingStatusComponent implements OnDestroy {
  private readonly tagging = inject(DialogueTaggingService);

  private readonly all = computed(() => Object.values(this.tagging.progress()));
  readonly total = computed(() => this.all().reduce((n, p) => n + p.total, 0));
  readonly done = computed(() => this.all().reduce((n, p) => n + p.done, 0));
  readonly justFinished = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wasWorking = false;

  constructor() {
    effect(() => {
      const working = this.total() > 0;
      untracked(() => {
        if (working) {
          this.clearTimer();
          this.justFinished.set(false);
        } else if (this.wasWorking) {
          this.justFinished.set(true);
          this.timer = setTimeout(() => { this.timer = null; this.justFinished.set(false); }, DONE_MS);
        }
        this.wasWorking = working;
      });
    });
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
