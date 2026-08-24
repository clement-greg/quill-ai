import { AuditedRecord } from './audited-record';

/**
 * Where a generation job has got to, from this server's point of view. The
 * receiver only knows "queued / running / in history" — these states are about
 * whether the finished files have been pulled back and attached to an entity.
 */
export type GenerationJobState =
  /** Queued on the receiver; nothing to collect yet. */
  | 'pending'
  /** Files are downloaded and stored, but not yet attached to the entity. */
  | 'stored'
  /** Files are on the entity. Terminal. */
  | 'collected'
  /** The receiver produced no output, or the run itself failed. Terminal. */
  | 'failed'
  /** The receiver no longer knows this job — restarted, or history pruned. Terminal. */
  | 'gone';

export const TERMINAL_GENERATION_STATES: GenerationJobState[] = ['collected', 'failed', 'gone'];

/** One collected asset, as it was stored and attached. */
export interface GenerationJobAsset {
  url: string;
  thumbnailUrl: string;
  /** The receiver's own filename for the output, kept for tracing. */
  sourceFilename: string;
}

/**
 * A generation job this server queued on the user's behalf and is waiting on.
 * Stored in the `generation-jobs` container keyed by the ComfyUI prompt id, so
 * the collector can find its work without holding anything in memory — a
 * restart mid-flight resumes rather than losing the job.
 */
export interface TrackedGenerationJob extends AuditedRecord {
  /** The ComfyUI prompt id. Also what a cancel and a /result lookup address. */
  id: string;
  kind: 'video' | 'images';
  /** The entity the finished assets are attached to — the one the job started from. */
  entityId: string;
  entityName?: string;
  seriesId?: string;
  state: GenerationJobState;
  /** Blob filename of the start frame, for showing what this job came from. */
  startImage?: string;
  /** Images asked for (image jobs) — the receiver may return a different number. */
  requestedCount?: number;
  /** Frame count asked for (video jobs), when a duration was given. */
  frames?: number | null;
  queuedAt: string;
  /** When the files were pulled back off the receiver. */
  collectedAt?: string;
  /** Assets stored so far. Written before they are attached, so a retry can't duplicate them. */
  assets?: GenerationJobAsset[];
  /** Collection attempts made, whether or not they got anywhere. */
  attempts: number;
  lastAttemptAt?: string;
  /** Why the last attempt got nowhere, for the queue screen and the logs. */
  lastError?: string;
}
