/**
 * Shape of the video/image generation queue as reported by the external
 * receiver (see receiver/server.py, GET /queue). The receiver answers in
 * snake_case; the relay in upload.routes.ts normalises it to these types so the
 * UI never has to know the wire format.
 */

/** Workflow settings read back off the queued graph. Best effort — a job queued
 * by another client may use a different workflow, so every field is optional. */
export interface GenerationJobSettings {
  width?: number;
  height?: number;
  /** Frame count (video jobs) — absent on still-image jobs. */
  length?: number;
  fps?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  /** Images per run (still-image jobs). */
  batchSize?: number;
}

/**
 * Step-level progress for the job being worked on. The receiver gets this off
 * ComfyUI's websocket, which addresses progress messages to the client id that
 * queued the job — so it exists for jobs the receiver queued and not for a job
 * another client submitted.
 */
export interface GenerationJobProgress {
  /** Always 'websocket' today; the receiver names its source explicitly. */
  source: string;
  percentComplete: number;
  /** Sampler steps: the denominator is known before the job starts. */
  stepsDone: number;
  stepsTotal: number;
  /** Age of the last websocket message — a stale feed shows as a large number. */
  updatedSecondsAgo: number | null;
  /** The node ComfyUI is executing right now, when it has said which. */
  currentNode: {
    id: string;
    classType: string | null;
    value: number | null;
    max: number | null;
  } | null;
}

export interface GenerationJob {
  /** ComfyUI's id for the job, and what a cancel is addressed to. */
  promptId: string;
  queueNumber: number | null;
  state: 'running' | 'pending';
  /** Filename of the start frame, when the workflow has one. */
  startImage: string | null;
  /** Prompt text, echoed back only for jobs this receiver queued itself. */
  prompt: string | null;
  /** False for a job queued by some other client — its prompt is withheld. */
  mine: boolean;
  queuedAt: string | null;
  startedAt: string | null;
  settings: GenerationJobSettings;
  /** Place in line, 1-based. Null for the job already running. */
  position: number | null;
  elapsedSeconds: number | null;
  /** Estimated progress of this job. Null until it starts running. */
  percentComplete: number | null;
  /** Real step progress, when the websocket feed has any for this job. */
  progress: GenerationJobProgress | null;
  /**
   * Where percentComplete came from: 'websocket' for real step counts,
   * 'elapsed-estimate' for elapsed time against an expected run time,
   * 'unknown' when neither is available. Null for a pending job.
   */
  progressSource: 'websocket' | 'elapsed-estimate' | 'unknown' | null;
  estimatedTotalSeconds: number | null;
  /** Seconds until this job finishes — its own run plus everything ahead of it. */
  etaSeconds: number | null;
  /** Seconds until a pending job starts. Null for the running job. */
  startsInSeconds: number | null;
}

export interface GenerationQueueStatus {
  counts: { running: number; pending: number; total: number };
  jobs: GenerationJob[];
  queue: {
    percentComplete: number;
    estimatedSecondsRemaining: number;
    idle: boolean;
  };
  /** How the estimates were arrived at, for showing as a caveat in the UI. */
  estimateBasis: { secondsPerFrame: number; measured: boolean; note: string };
  /** State of the receiver's websocket feed — without it there are no step counts. */
  progressFeed: { connected: boolean; messages: number | null; error: string | null; note: string };
}

export interface GenerationCancelResult {
  promptId: string;
  cancelled: boolean;
  /** What the receiver did: removed from the queue, or interrupted mid-run. */
  action: string | null;
}
