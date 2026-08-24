import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { HeaderService } from '@app/core/services/header.service';
import { ConfirmDialogComponent } from '@app/shared/confirm-dialog/confirm-dialog';
import { GenerationQueueService } from './generation-queue.service';
import { GenerationJob, GenerationQueueStatus } from '@shared/models/generation-queue.model';
import { TrackedGenerationJob } from '@shared/models/generation-job.model';

/** How often the queue is re-read while the screen is open and visible. */
const POLL_INTERVAL_MS = 10_000;

@Component({
  selector: 'app-generation-queue',
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './generation-queue.html',
  styleUrl: './generation-queue.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:visibilitychange)': 'onVisibilityChange()' },
})
export class GenerationQueueComponent implements OnInit, OnDestroy {
  private queueService = inject(GenerationQueueService);
  private headerService = inject(HeaderService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  status = signal<GenerationQueueStatus | null>(null);
  /** Quill's own record of the jobs it queued, and where each one ended up. */
  trackedJobs = signal<TrackedGenerationJob[]>([]);
  router = inject(Router);
  /** Only true for the very first read — a poll refresh must not blank the list. */
  loading = signal(true);
  error = signal<string | null>(null);
  /** Prompt ids with a cancel in flight, so their buttons can spin and lock. */
  cancelling = signal<Set<string>>(new Set());

  private timer: ReturnType<typeof setInterval> | null = null;

  readonly jobs = computed(() => this.status()?.jobs ?? []);
  readonly counts = computed(() => this.status()?.counts ?? { running: 0, pending: 0, total: 0 });
  readonly isIdle = computed(() => !!this.status() && this.jobs().length === 0);

  /** Jobs whose assets have not landed yet — what the collector is working on. */
  readonly awaitingCollection = computed(() =>
    this.trackedJobs().filter(j => j.state === 'pending' || j.state === 'stored')
  );

  /** Jobs that have finished, one way or another. */
  readonly finishedJobs = computed(() =>
    this.trackedJobs().filter(j => j.state !== 'pending' && j.state !== 'stored')
  );

  ngOnInit(): void {
    this.headerService.setPage('Generation Queue');
    this.load();
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  /** Polling is wasted work on a hidden tab, and the queue is re-read on return. */
  onVisibilityChange(): void {
    if (document.hidden) {
      this.stopPolling();
    } else {
      this.load();
      this.startPolling();
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.timer = setInterval(() => this.load(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  load(): void {
    // Read on its own so a receiver that is offline still leaves the tracked
    // list — which is Quill's own data — on screen.
    this.queueService.getTrackedJobs().subscribe({
      next: ({ jobs }) => this.trackedJobs.set(jobs),
      error: () => undefined,
    });

    this.queueService.getStatus().subscribe({
      next: (status) => {
        this.status.set(status);
        this.error.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error ?? 'Could not read the generation queue.');
        this.loading.set(false);
      },
    });
  }

  /** Where a tracked job got to, in words. */
  trackedStateLabel(job: TrackedGenerationJob): string {
    switch (job.state) {
      case 'pending':
        return 'Generating';
      case 'stored':
        return 'Attaching';
      case 'collected':
        return 'Added to ' + (job.entityName ?? 'the entity');
      case 'failed':
        return 'Failed';
      case 'gone':
        return 'Lost';
    }
  }

  trackedStateIcon(job: TrackedGenerationJob): string {
    switch (job.state) {
      case 'pending':
      case 'stored':
        return 'hourglass_empty';
      case 'collected':
        return 'check_circle';
      default:
        return 'error_outline';
    }
  }

  /** What the job asked for, e.g. "4 images" or "1 video". */
  trackedKindLabel(job: TrackedGenerationJob): string {
    if (job.kind === 'video') return '1 video';
    const n = job.requestedCount ?? 1;
    return `${n} image${n === 1 ? '' : 's'}`;
  }

  openEntity(job: TrackedGenerationJob): void {
    this.router.navigate(['/entities', job.entityId]);
  }

  dismissTracked(job: TrackedGenerationJob): void {
    this.queueService.dismissTrackedJob(job.id).subscribe({
      next: () => this.trackedJobs.update(jobs => jobs.filter(j => j.id !== job.id)),
      error: () => this.snackBar.open('Could not dismiss that job.', undefined, { duration: 3000 }),
    });
  }

  isCancelling(job: GenerationJob): boolean {
    return this.cancelling().has(job.promptId);
  }

  confirmCancel(job: GenerationJob): void {
    if (this.isCancelling(job)) return;
    const running = job.state === 'running';
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: running ? 'Cancel the running job?' : 'Cancel this queued job?',
        message: running
          ? `"${this.jobLabel(job)}" is generating now. Cancelling interrupts it and the video is lost.`
          : `"${this.jobLabel(job)}" will be removed from the queue and never generated.`,
        confirm: 'Cancel Job',
      },
      width: '400px',
    });
    dialogRef.afterClosed().subscribe((confirmed) => {
      if (confirmed) this.cancel(job);
    });
  }

  private cancel(job: GenerationJob): void {
    this.cancelling.update((set) => new Set(set).add(job.promptId));
    this.queueService.cancel(job.promptId).subscribe({
      next: (result) => {
        this.releaseCancelling(job.promptId);
        this.snackBar.open(
          result.action ? `Job ${result.action}` : 'Job cancelled',
          undefined,
          { duration: 3000 },
        );
        // Drop it locally rather than wait on the next poll, so the click lands.
        this.status.update((s) =>
          s ? { ...s, jobs: s.jobs.filter((j) => j.promptId !== job.promptId) } : s,
        );
        this.load();
      },
      error: (err) => {
        this.releaseCancelling(job.promptId);
        this.snackBar.open(
          err?.error?.error ?? 'Could not cancel the job.',
          undefined,
          { duration: 5000 },
        );
        // A 404/409 means it already left the queue — the fresh read says so.
        this.load();
      },
    });
  }

  private releaseCancelling(promptId: string): void {
    this.cancelling.update((set) => {
      const next = new Set(set);
      next.delete(promptId);
      return next;
    });
  }

  /**
   * Something short to identify a job by in a dialog or a heading. The prompt is
   * not used — the queue does not show what was asked for.
   */
  jobLabel(job: GenerationJob): string {
    if (job.startImage) return job.startImage;
    return `Job ${job.promptId.slice(0, 8)}`;
  }

  /** True when the percentage comes from real sampler steps, not elapsed time. */
  isLive(job: GenerationJob): boolean {
    return job.progressSource === 'websocket';
  }

  /** Step counter for the running job: "step 9 of 20". */
  stepText(job: GenerationJob): string | null {
    const p = job.progress;
    if (!p) return null;
    return `step ${Math.round(p.stepsDone)} of ${Math.round(p.stepsTotal)}`;
  }

  /**
   * What ComfyUI is executing right now — the node's class is the readable part
   * ("KSamplerAdvanced"), with its own step count when the node reports one.
   */
  nodeText(job: GenerationJob): string | null {
    const node = job.progress?.currentNode;
    if (!node) return null;
    const name = node.classType ?? `node ${node.id}`;
    return node.value !== null && node.max ? `${name} · ${Math.round(node.value)}/${node.max}` : name;
  }

  /**
   * Why a running job shows no numbers, when it shows none. ComfyUI aims its
   * progress messages at the client id that queued the job, so a job submitted
   * outside Quill reports nothing at all — worth saying, since the alternative
   * is a progress bar with an empty space under it.
   */
  noProgressReason(job: GenerationJob): string | null {
    if (job.state !== 'running' || job.progress || job.percentComplete !== null) return null;
    if (!job.mine) return 'No progress reported — this job was queued outside Quill';
    if (!this.status()?.progressFeed.connected) return 'Waiting on the progress feed to reconnect';
    return 'Waiting for the first progress report';
  }

  /** Percentage for the running job's bar; 0 until the receiver has an estimate. */
  progressOf(job: GenerationJob): number {
    return Math.max(0, Math.min(100, job.percentComplete ?? 0));
  }

  /** Shape of the output, when the queued workflow told us: 832x480 · 81 frames. */
  shapeOf(job: GenerationJob): string | null {
    const s = job.settings;
    const parts: string[] = [];
    if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
    if (s.length) parts.push(`${s.length} frames`);
    if (s.batchSize) parts.push(`${s.batchSize} image${s.batchSize === 1 ? '' : 's'}`);
    if (s.steps) parts.push(`${s.steps} steps`);
    return parts.length ? parts.join(' · ') : null;
  }

  /** A duration as m:ss, or seconds alone under a minute. */
  formatDuration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  }

  formatTime(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
}
