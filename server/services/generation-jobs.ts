import { getContainer } from './cosmos';
import { withOwnerFilter } from '../middleware/owner-guard';
import {
  GenerationJobAsset,
  GenerationJobState,
  TrackedGenerationJob,
} from '../../shared/models/generation-job.model';

/**
 * The record store behind the generation collector. Jobs live in Cosmos rather
 * than in memory so a restart between queueing and collecting resumes the job
 * instead of orphaning the output on the receiver.
 */
const container = () => getContainer('generation-jobs');

/** How long a job may stay uncollected before it is written off. */
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;

/** Terminal records are kept this long so the queue screen can show what happened. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TrackJobInput {
  promptId: string;
  kind: 'video' | 'images';
  entityId: string;
  entityName?: string;
  seriesId?: string;
  owner: string;
  startImage?: string;
  requestedCount?: number;
  frames?: number | null;
}

/**
 * Records a job that was just queued on the receiver. Written after the receiver
 * has accepted it, so a record always corresponds to something real; if this
 * write fails the job still runs, it just won't be collected automatically.
 */
export async function trackJob(input: TrackJobInput): Promise<TrackedGenerationJob> {
  const now = new Date().toISOString();
  const job: TrackedGenerationJob = {
    id: input.promptId,
    kind: input.kind,
    entityId: input.entityId,
    ...(input.entityName ? { entityName: input.entityName } : {}),
    ...(input.seriesId ? { seriesId: input.seriesId } : {}),
    ...(input.startImage ? { startImage: input.startImage } : {}),
    ...(input.requestedCount !== undefined ? { requestedCount: input.requestedCount } : {}),
    ...(input.frames !== undefined ? { frames: input.frames } : {}),
    state: 'pending',
    queuedAt: now,
    attempts: 0,
    owner: input.owner,
    createdBy: input.owner,
    createdAt: now,
    modifiedBy: input.owner,
    modifiedAt: now,
  };
  const { resource } = await container().items.upsert<TrackedGenerationJob>(job);
  return resource ?? job;
}

/**
 * Every job still waiting to be collected, oldest first, across all users — the
 * collector runs outside any request, so it is deliberately not owner-scoped.
 * `stored` counts as outstanding: the files are down but not yet attached.
 */
export async function listOutstandingJobs(): Promise<TrackedGenerationJob[]> {
  const { resources } = await container()
    .items.query<TrackedGenerationJob>({
      query: "SELECT * FROM c WHERE c.state IN ('pending', 'stored') ORDER BY c.queuedAt ASC",
    })
    .fetchAll();
  return resources;
}

/** A user's own jobs, newest first, for the queue screen. */
export async function listJobsForOwner(
  owner: string,
  limit = 50
): Promise<TrackedGenerationJob[]> {
  const { resources } = await container()
    .items.query<TrackedGenerationJob>(
      withOwnerFilter(owner, {
        query: 'SELECT TOP @limit * FROM c ORDER BY c.queuedAt DESC',
        parameters: [{ name: '@limit', value: limit }],
      })
    )
    .fetchAll();
  return resources;
}

/** A user's outstanding jobs for one entity — what the entity screen waits on. */
export async function listOutstandingJobsForEntity(
  owner: string,
  entityId: string
): Promise<TrackedGenerationJob[]> {
  const { resources } = await container()
    .items.query<TrackedGenerationJob>(
      withOwnerFilter(owner, {
        query:
          "SELECT * FROM c WHERE c.entityId = @entityId AND c.state IN ('pending', 'stored') ORDER BY c.queuedAt ASC",
        parameters: [{ name: '@entityId', value: entityId }],
      })
    )
    .fetchAll();
  return resources;
}

export async function readJob(promptId: string): Promise<TrackedGenerationJob | null> {
  const { resource } = await container()
    .item(promptId, promptId)
    .read<TrackedGenerationJob>()
    .catch(() => ({ resource: undefined }));
  return resource ?? null;
}

/** Patches a job record. The caller owns the state machine; this only persists it. */
export async function updateJob(
  job: TrackedGenerationJob,
  changes: Partial<TrackedGenerationJob>
): Promise<TrackedGenerationJob> {
  const updated: TrackedGenerationJob = {
    ...job,
    ...changes,
    modifiedAt: new Date().toISOString(),
  };
  const { resource } = await container()
    .item(job.id, job.id)
    .replace<TrackedGenerationJob>(updated);
  return resource ?? updated;
}

/** Records that an attempt was made and got nowhere, without changing state. */
export async function noteAttempt(
  job: TrackedGenerationJob,
  error?: string
): Promise<TrackedGenerationJob> {
  return updateJob(job, {
    attempts: (job.attempts ?? 0) + 1,
    lastAttemptAt: new Date().toISOString(),
    ...(error ? { lastError: error } : {}),
  });
}

export async function markStored(
  job: TrackedGenerationJob,
  assets: GenerationJobAsset[]
): Promise<TrackedGenerationJob> {
  return updateJob(job, {
    state: 'stored',
    assets,
    attempts: (job.attempts ?? 0) + 1,
    lastAttemptAt: new Date().toISOString(),
  });
}

export async function markTerminal(
  job: TrackedGenerationJob,
  state: Extract<GenerationJobState, 'collected' | 'failed' | 'gone'>,
  error?: string
): Promise<TrackedGenerationJob> {
  return updateJob(job, {
    state,
    ...(state === 'collected' ? { collectedAt: new Date().toISOString() } : {}),
    lastAttemptAt: new Date().toISOString(),
    ...(error ? { lastError: error } : {}),
  });
}

/** Forgets one job record. The generation itself is unaffected. */
export async function forgetJob(promptId: string): Promise<void> {
  await container().item(promptId, promptId).delete();
}

export function jobAgeMs(job: TrackedGenerationJob, now = Date.now()): number {
  const queued = Date.parse(job.queuedAt);
  return Number.isFinite(queued) ? now - queued : 0;
}

/** True once a job has been waiting long enough to stop asking about it. */
export function isExpired(job: TrackedGenerationJob, now = Date.now()): boolean {
  return jobAgeMs(job, now) > MAX_JOB_AGE_MS;
}

/**
 * Drops terminal records past the retention window. Housekeeping only — the
 * container would otherwise grow one document per generation forever.
 */
export async function pruneOldJobs(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  const { resources } = await container()
    .items.query<{ id: string }>({
      query:
        "SELECT c.id FROM c WHERE c.state IN ('collected', 'failed', 'gone') AND c.queuedAt < @cutoff",
      parameters: [{ name: '@cutoff', value: cutoff }],
    })
    .fetchAll();

  let removed = 0;
  for (const { id } of resources) {
    try {
      await container().item(id, id).delete();
      removed++;
    } catch {
      // A record that is already gone is the outcome this wanted anyway.
    }
  }
  return removed;
}

export { MAX_JOB_AGE_MS };
