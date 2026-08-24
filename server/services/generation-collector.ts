import path from 'path';
import { getContainer } from './cosmos';
import { decrypt } from './crypto';
import { storeMedia } from './media-store';
import { hasReceiver, receiverError, receiverUrl, RECEIVER_HEADERS } from './receiver';
import {
  isExpired,
  listOutstandingJobs,
  markStored,
  markTerminal,
  noteAttempt,
  pruneOldJobs,
} from './generation-jobs';
import { Entity, EntityPhoto } from '../../shared/models/entity.model';
import {
  GenerationJobAsset,
  TrackedGenerationJob,
} from '../../shared/models/generation-job.model';

/**
 * Pulls finished generation jobs back off the receiver and attaches them to the
 * entity they were started from.
 *
 * The receiver keeps a job's output until asked for it (GET /result), so nothing
 * is lost while this waits — but nothing arrives on its own either. This is the
 * half that closes the loop: poll the outstanding jobs, download what is ready,
 * store it, and put it on the entity.
 *
 * Collected assets are marked hidden, the app's private flag for gallery media:
 * generated stills and clips land out of sight and are revealed deliberately
 * (the Photos triple-tap) rather than appearing unbidden in a shared gallery.
 */

/** Generated media is private on arrival — see the note above. */
const COLLECTED_PHOTOS_ARE_HIDDEN = true;

/** How often the outstanding jobs are checked. */
const POLL_INTERVAL_MS = Number(process.env['GENERATION_POLL_MS'] ?? 30_000);

/** Downloading a batch of stills or a video is the slow call here. */
const RESULT_TIMEOUT_MS = 180_000;

/** Consecutive "the receiver has never heard of this" answers before giving up. */
const UNKNOWN_ATTEMPTS_BEFORE_GONE = 3;

/** Jobs are collected one at a time — a video download is large, and there is no rush. */
let ticking = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** One output file as the receiver returns it from /result?all=1. */
interface ReceiverResultFile {
  filename?: string;
  content_type?: string;
  data_base64?: string;
}

type ResultOutcome =
  | { kind: 'ready'; files: ReceiverResultFile[] }
  /** Still queued or running — ask again later. */
  | { kind: 'waiting' }
  /** The receiver answered, and this job produced nothing. Terminal. */
  | { kind: 'no-output'; reason: string }
  /** The receiver has no record of this job at all. */
  | { kind: 'unknown'; reason: string }
  /** Could not ask, or the answer was unusable. Worth retrying. */
  | { kind: 'error'; reason: string }
  | { kind: 'no-receiver' };

/**
 * Asks the receiver for a job's finished files. Its 404 covers two very
 * different things — "produced no output" (which is terminal) and "never heard
 * of it" (which might just be a ComfyUI restart) — so they are told apart by
 * whether the body carries a `files` array.
 */
async function fetchResult(promptId: string): Promise<ResultOutcome> {
  const target = receiverUrl('/result', { prompt_id: promptId, all: '1' });
  if (!target) return { kind: 'no-receiver' };

  let response: globalThis.Response;
  try {
    response = await fetch(target, {
      headers: RECEIVER_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(RESULT_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { kind: 'error', reason: `could not reach the receiver (${detail})` };
  }

  // A dev tunnel that is not anonymously accessible redirects to a sign-in page;
  // following it would return HTML and look like an answer.
  if (response.status >= 300 && response.status < 400) {
    return { kind: 'error', reason: 'receiver requires sign-in — make the tunnel public' };
  }

  // 202 is the receiver's own "not finished yet".
  if (response.status === 202) return { kind: 'waiting' };

  if (response.status === 404) {
    const body = (await response.json().catch(() => null)) as
      | { files?: unknown; error?: string; state?: string }
      | null;
    const reason = typeof body?.error === 'string' ? body.error : 'no result';
    // `files: []` means the job is in history and finished with nothing to show.
    return Array.isArray(body?.files)
      ? { kind: 'no-output', reason }
      : { kind: 'unknown', reason };
  }

  if (!response.ok) {
    return { kind: 'error', reason: await receiverError(response) };
  }

  const body = (await response.json().catch(() => null)) as
    | { files?: ReceiverResultFile[] }
    | null;
  const files = Array.isArray(body?.files) ? body.files : [];
  if (files.length === 0) {
    return { kind: 'error', reason: 'the receiver sent an unreadable result' };
  }
  return { kind: 'ready', files };
}

/**
 * Decrypts and stores one output file. The receiver wraps every result in the
 * same AES-256-GCM envelope this server uses at rest — [IV 12][tag 16][body] —
 * so the shared key opens it directly.
 */
async function storeResultFile(
  file: ReceiverResultFile,
  promptId: string
): Promise<GenerationJobAsset | null> {
  const filename = typeof file.filename === 'string' ? path.basename(file.filename) : '';
  if (!filename || typeof file.data_base64 !== 'string') return null;

  let plaintext: Buffer;
  try {
    plaintext = decrypt(Buffer.from(file.data_base64, 'base64'));
  } catch (err) {
    // A key mismatch fails the tag check here rather than producing garbage.
    console.error(
      `Generation ${promptId}: could not decrypt ${filename} — is cryptoKey the same on both sides?`,
      err
    );
    return null;
  }

  const ext = path.extname(filename).toLowerCase();
  const stored = await storeMedia(plaintext, {
    ext,
    mimeType: typeof file.content_type === 'string' ? file.content_type : 'application/octet-stream',
  });
  return { ...stored, sourceFilename: filename };
}

/**
 * Puts the stored assets on the entity, hidden. Existing urls are skipped, so
 * running this twice — a crash between storing and attaching, say — attaches
 * each asset once rather than duplicating it.
 */
async function attachToEntity(job: TrackedGenerationJob): Promise<{ ok: true; added: number } | { ok: false; reason: string }> {
  const assets = job.assets ?? [];
  if (assets.length === 0) return { ok: false, reason: 'nothing was stored to attach' };

  const container = getContainer('entities');
  const { resource: entity } = await container
    .item(job.entityId, job.entityId)
    .read<Entity>()
    .catch(() => ({ resource: undefined }));

  if (!entity) return { ok: false, reason: 'the entity no longer exists' };
  // The job records who queued it; an entity that has since changed hands must
  // not receive someone else's generated media.
  if (job.owner && entity.owner !== job.owner) {
    return { ok: false, reason: 'the entity is no longer owned by the user who queued the job' };
  }

  const existing = new Set((entity.photos ?? []).map(p => p.url));
  const additions: EntityPhoto[] = assets
    .filter(a => !existing.has(a.url))
    .map(a => ({
      url: a.url,
      thumbnailUrl: a.thumbnailUrl,
      ...(COLLECTED_PHOTOS_ARE_HIDDEN ? { hidden: true } : {}),
    }));

  if (additions.length > 0) {
    const updated: Entity = {
      ...entity,
      photos: [...(entity.photos ?? []), ...additions],
      modifiedBy: job.owner ?? entity.modifiedBy,
      modifiedAt: new Date().toISOString(),
    };
    await container.item(job.entityId, job.entityId).replace<Entity>(updated);
  }
  return { ok: true, added: additions.length };
}

/**
 * Tells the receiver the outputs have been taken, so its ComfyUI output folder
 * doesn't grow a copy of everything ever generated. Best effort: the assets are
 * already safely stored here, so a receiver that can't or won't delete them
 * changes nothing.
 */
async function releaseOnReceiver(promptId: string): Promise<void> {
  const target = receiverUrl('/result', { prompt_id: promptId });
  if (!target) return;
  try {
    const response = await fetch(target, {
      method: 'DELETE',
      headers: RECEIVER_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && response.status !== 404) {
      console.warn(`Generation ${promptId}: receiver would not release the outputs (${response.status})`);
    }
  } catch (err) {
    console.warn(`Generation ${promptId}: could not ask the receiver to release the outputs`, err);
  }
}

/**
 * Moves one job as far along as it can go this tick. Exported so a route can
 * ask for an immediate check instead of waiting out the interval.
 */
export async function collectJob(job: TrackedGenerationJob): Promise<TrackedGenerationJob> {
  // Already downloaded, only the attach failed — pick up where it stopped
  // rather than pulling the same bytes down again.
  if (job.state === 'stored') return finishJob(job);

  const outcome = await fetchResult(job.id);

  switch (outcome.kind) {
    case 'no-receiver':
      return job;

    case 'waiting':
      // Not an attempt worth recording — the job is simply still in the queue.
      return isExpired(job)
        ? markTerminal(job, 'gone', 'the job never finished within a day')
        : job;

    case 'no-output':
      console.warn(`Generation ${job.id}: produced no output — ${outcome.reason}`);
      return markTerminal(job, 'failed', outcome.reason);

    case 'unknown': {
      const noted = await noteAttempt(job, outcome.reason);
      // ComfyUI's history is the source for /result, so "unknown" usually means
      // ComfyUI restarted and the output is unrecoverable. Confirmed a few times
      // before writing off, in case the receiver answered mid-restart.
      if (noted.attempts >= UNKNOWN_ATTEMPTS_BEFORE_GONE || isExpired(noted)) {
        return markTerminal(noted, 'gone', outcome.reason);
      }
      return noted;
    }

    case 'error': {
      const noted = await noteAttempt(job, outcome.reason);
      console.warn(`Generation ${job.id}: ${outcome.reason}`);
      return isExpired(noted) ? markTerminal(noted, 'gone', outcome.reason) : noted;
    }

    case 'ready': {
      const assets: GenerationJobAsset[] = [];
      for (const file of outcome.files) {
        const asset = await storeResultFile(file, job.id);
        if (asset) assets.push(asset);
      }
      if (assets.length === 0) {
        return markTerminal(job, 'failed', 'the finished files could not be read');
      }
      // Recorded before attaching: if the process dies here the urls are known,
      // so the retry attaches them instead of downloading and storing again.
      const stored = await markStored(job, assets);
      return finishJob(stored);
    }
  }
}

/** The attach half, split out so a `stored` job can resume at it. */
async function finishJob(job: TrackedGenerationJob): Promise<TrackedGenerationJob> {
  const result = await attachToEntity(job);
  if (!result.ok) {
    const noted = await noteAttempt(job, result.reason);
    // An entity that is gone or has changed hands is never coming back — no
    // point retrying that one until it ages out.
    console.warn(`Generation ${job.id}: could not attach to entity ${job.entityId} — ${result.reason}`);
    return isExpired(noted) ? markTerminal(noted, 'failed', result.reason) : noted;
  }

  const collected = await markTerminal(job, 'collected');
  console.log(
    `Generation ${job.id}: collected ${job.assets?.length ?? 0} file(s) onto entity ${job.entityId}` +
      (result.added === 0 ? ' (already attached)' : '')
  );
  await releaseOnReceiver(job.id);
  return collected;
}

/**
 * Runs one pass over the outstanding jobs. Sequential on purpose: a video
 * result is tens of megabytes, and nothing here is time-critical.
 */
export async function collectOnce(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const jobs = await listOutstandingJobs();
    for (const job of jobs) {
      try {
        await collectJob(job);
      } catch (err) {
        // One bad job must not stop the others; it stays outstanding and is
        // retried on the next pass.
        console.error(`Generation ${job.id}: collection failed`, err);
      }
    }
  } catch (err) {
    console.error('Generation collector could not read its work list', err);
  } finally {
    ticking = false;
  }
}

/**
 * Collects one job right now, if it is outstanding. Used to answer a client that
 * has just been told a job finished, so it doesn't wait out the poll interval.
 */
export async function collectJobNow(job: TrackedGenerationJob): Promise<TrackedGenerationJob> {
  if (job.state !== 'pending' && job.state !== 'stored') return job;
  return collectJob(job);
}

/**
 * Starts the background poller. A no-op without a receiver configured — there
 * would be nothing to ask.
 */
export function startGenerationCollector(): void {
  if (!hasReceiver()) {
    console.log('Generation collector not started: no receiver configured (PHOTO_EXPORT_URL)');
    return;
  }
  if (timer) return;

  console.log(`Generation collector polling every ${Math.round(POLL_INTERVAL_MS / 1000)}s`);
  // First pass shortly after boot, so a job that finished while the server was
  // down is picked up without waiting a full interval.
  setTimeout(() => void collectOnce(), 5_000);
  timer = setInterval(() => {
    void collectOnce();
    void pruneOldJobs().catch(() => undefined);
  }, POLL_INTERVAL_MS);
  // Housekeeping should not be the reason the process stays alive.
  timer.unref?.();
}

export function stopGenerationCollector(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
