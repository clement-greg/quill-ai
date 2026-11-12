/**
 * Whole-database backups: every Cosmos container streamed into one zip in blob
 * storage, taken automatically once a week and on demand from Settings.
 *
 * Zip layout (see README.txt inside each backup):
 *   manifest.json             — when, which database, and each container's full
 *                               definition (partition key, indexing and vector
 *                               policies) plus its document count
 *   containers/<id>.jsonl     — one document per line, exactly as stored minus
 *                               Cosmos's own system fields (_rid, _self, _etag,
 *                               _attachments)
 * Restoring is: create each container from its manifest definition, then
 * insert every line of its .jsonl file, skipping ids that already exist.
 * scripts/restore-backup.ts does that.
 *
 * The zip is stored unencrypted (unlike uploaded media) so it opens as-is when
 * downloaded from the storage account — a backup that needs this app's crypto
 * key to read is no use when the app itself is what's broken.
 *
 * Backups older than RETENTION_DAYS are deleted after each successful run,
 * except the newest one, which is never deleted however old it is.
 */
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { ContainerDefinition } from '@azure/cosmos';
import yazl from 'yazl';
import config from '../config';
import { getContainer, listContainerDefinitions } from './cosmos';
import { deleteBlob, listBlobsWithPrefix, uploadStreamToBlobRaw, BlobListing } from './storage';
import {
  DatabaseBackupFile,
  DatabaseBackupRun,
  DatabaseBackupStatus,
  DatabaseBackupTrigger,
} from '../../shared/models/database-backup.model';

export const BACKUP_PREFIX = 'backups/';
export const BACKUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = 31;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** After a failed scheduled attempt, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
/** A run still marked "running" after this long is assumed dead (process restarted mid-backup). */
const STALE_RUN_MS = 3 * 60 * 60 * 1000;
/** How often the scheduler checks whether a backup is due. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;

const STATUS_DOC_ID = 'database-backup';
const SYSTEM_FIELDS = ['_rid', '_self', '_etag', '_attachments'];
const MANIFEST_FORMAT_VERSION = 1;

/** Persisted in the app-settings container so every instance (and restarts) agree on when the last backup ran. */
interface BackupStatusDoc {
  id: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastRun: DatabaseBackupRun | null;
  _etag?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** "backups/quill-backup-2026-11-12T03-00-00Z.zip" — sortable, and safe in a URL path. */
export function backupBlobName(at: Date): string {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${BACKUP_PREFIX}quill-backup-${stamp}.zip`;
}

export function isBackupBlobName(name: string): boolean {
  return /^backups\/quill-backup-[0-9TZ-]+\.zip$/.test(name);
}

/** Whether the scheduler should start a backup now. */
export function isBackupDue(doc: Pick<BackupStatusDoc, 'lastSuccessAt' | 'lastAttemptAt'> | null, now: Date): boolean {
  if (!doc) return true;
  const since = (iso: string | null) => (iso ? now.getTime() - new Date(iso).getTime() : Infinity);
  if (since(doc.lastSuccessAt) < BACKUP_INTERVAL_MS) return false;
  // An attempt newer than the last success failed. Don't retry it every hour
  // while whatever broke it is still broken.
  const failedSinceSuccess = !!doc.lastAttemptAt && (!doc.lastSuccessAt || doc.lastAttemptAt > doc.lastSuccessAt);
  return !failedSinceSuccess || since(doc.lastAttemptAt) >= RETRY_AFTER_FAILURE_MS;
}

export function isRunInProgress(run: DatabaseBackupRun | null | undefined, now: Date): boolean {
  return run?.status === 'running' && now.getTime() - new Date(run.startedAt).getTime() < STALE_RUN_MS;
}

/** Backups older than the retention window — never the newest, so there is always one left. */
export function selectBackupsToPrune(backups: BlobListing[], now: Date): string[] {
  const dated = backups
    .filter(b => isBackupBlobName(b.name))
    .sort((a, b) => b.name.localeCompare(a.name)); // newest first (names are timestamps)
  return dated
    .slice(1)
    .filter(b => b.createdOn && now.getTime() - b.createdOn.getTime() > RETENTION_MS)
    .map(b => b.name);
}

/** A document as written to the backup: everything but Cosmos's own bookkeeping. */
export function toBackupDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...doc };
  for (const field of SYSTEM_FIELDS) delete copy[field];
  return copy;
}

/** The parts of a container definition needed to recreate it. */
export function toContainerSpec(def: ContainerDefinition): Record<string, unknown> {
  const { id, partitionKey, indexingPolicy, uniqueKeyPolicy, defaultTtl, conflictResolutionPolicy } = def;
  const vectorEmbeddingPolicy = (def as any).vectorEmbeddingPolicy;
  const fullTextPolicy = (def as any).fullTextPolicy;
  return Object.fromEntries(
    Object.entries({
      id, partitionKey, indexingPolicy, uniqueKeyPolicy, defaultTtl,
      conflictResolutionPolicy, vectorEmbeddingPolicy, fullTextPolicy,
    }).filter(([, v]) => v !== undefined),
  );
}

// ---------------------------------------------------------------------------
// Writing the zip
// ---------------------------------------------------------------------------

const README = `Quill AI database backup
========================

manifest.json           Backup time, source database, and for every container its
                        definition (partition key, indexing / vector policies) and
                        document count.
containers/<id>.jsonl   Every document in that container, one JSON object per line,
                        as stored in Cosmos DB minus the system fields
                        _rid, _self, _etag and _attachments.

To restore: create each container from its manifest definition, then insert each
line of its .jsonl file into it, skipping documents whose id already exists. scripts/restore-backup.ts in the Quill AI repo
does exactly this.
`;

async function* containerLines(containerId: string, counts: Record<string, number>): AsyncGenerator<Buffer> {
  counts[containerId] = 0;
  const iterator = getContainer(containerId).items.readAll<Record<string, unknown>>({ maxItemCount: 200 });
  for await (const page of iterator.getAsyncIterator()) {
    for (const doc of page.resources) {
      counts[containerId]++;
      yield Buffer.from(JSON.stringify(toBackupDocument(doc)) + '\n', 'utf8');
    }
  }
}

/** Streams every container into a zip and uploads it; returns the per-container document counts. */
async function writeBackup(blobName: string, startedAt: Date): Promise<Record<string, number>> {
  const definitions = (await listContainerDefinitions()).sort((a, b) => a.id!.localeCompare(b.id!));
  const counts: Record<string, number> = {};
  const zip = new yazl.ZipFile();
  const sources: Readable[] = [];

  const upload = uploadStreamToBlobRaw(zip.outputStream, blobName, 'application/zip');

  const fill = (async () => {
    zip.addBuffer(Buffer.from(README, 'utf8'), 'README.txt', { mtime: startedAt });
    const done: Promise<void>[] = [];
    for (const def of definitions) {
      const source = Readable.from(containerLines(def.id!, counts), { objectMode: false });
      sources.push(source);
      done.push(finished(source));
      zip.addReadStream(source, `containers/${def.id}.jsonl`, { mtime: startedAt });
    }
    await Promise.all(done);
    const manifest = {
      formatVersion: MANIFEST_FORMAT_VERSION,
      app: 'quill-ai',
      database: config.cosmosDatabase,
      createdAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      containers: definitions.map(def => ({
        file: `containers/${def.id}.jsonl`,
        documentCount: counts[def.id!] ?? 0,
        definition: toContainerSpec(def),
      })),
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json', { mtime: startedAt });
    zip.end();
  })();

  try {
    await Promise.all([fill, upload]);
  } catch (err) {
    // Unblock whichever side is still waiting on the other. An unfinished
    // uploadStream never commits its block list, so no partial zip is left.
    for (const source of sources) source.destroy();
    (zip.outputStream as Readable).destroy();
    throw err;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Status, locking, and running
// ---------------------------------------------------------------------------

function statusContainer() {
  return getContainer('app-settings');
}

async function readStatusDoc(): Promise<BackupStatusDoc | null> {
  try {
    const { resource } = await statusContainer().item(STATUS_DOC_ID, STATUS_DOC_ID).read<BackupStatusDoc>();
    return resource ?? null;
  } catch (err: any) {
    if (err.code === 404) return null;
    throw err;
  }
}

async function writeStatusDoc(doc: BackupStatusDoc): Promise<void> {
  const { _etag, ...body } = doc;
  await statusContainer().items.upsert(body);
}

/**
 * Marks a run as started, unless one is already running (here or on another
 * instance) or — for a scheduled run — none is due. The write is conditioned
 * on the document's etag so two instances checking at once can't both win.
 */
async function claimRun(trigger: DatabaseBackupTrigger, requestedBy: string | undefined, now: Date): Promise<DatabaseBackupRun | null> {
  const existing = await readStatusDoc();
  if (isRunInProgress(existing?.lastRun, now)) return null;
  if (trigger === 'scheduled' && !isBackupDue(existing, now)) return null;

  const run: DatabaseBackupRun = { trigger, requestedBy, startedAt: now.toISOString(), status: 'running' };
  const next: BackupStatusDoc = {
    id: STATUS_DOC_ID,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastAttemptAt: now.toISOString(),
    lastRun: run,
  };
  try {
    if (existing?._etag) {
      await statusContainer().item(STATUS_DOC_ID, STATUS_DOC_ID).replace(next, {
        accessCondition: { type: 'IfMatch', condition: existing._etag },
      });
    } else {
      await statusContainer().items.create(next);
    }
  } catch (err: any) {
    if (err.code === 412 || err.code === 409) return null; // another instance got there first
    throw err;
  }
  return run;
}

let localRun: Promise<void> | null = null;

export async function pruneOldBackups(now = new Date()): Promise<string[]> {
  const toDelete = selectBackupsToPrune(await listBlobsWithPrefix(BACKUP_PREFIX), now);
  for (const name of toDelete) await deleteBlob(name);
  return toDelete;
}

async function executeRun(run: DatabaseBackupRun): Promise<void> {
  const startedAt = new Date(run.startedAt);
  const blobName = backupBlobName(startedAt);
  console.log(`[backup] ${run.trigger} backup started → ${blobName}`);
  let finishedRun: DatabaseBackupRun;
  let lastSuccessAt: string | null = null;
  try {
    const documentCounts = await writeBackup(blobName, startedAt);
    const finishedAt = new Date().toISOString();
    finishedRun = { ...run, status: 'succeeded', finishedAt, blobName, documentCounts };
    lastSuccessAt = run.startedAt;
    const total = Object.values(documentCounts).reduce((a, b) => a + b, 0);
    console.log(`[backup] finished: ${total} documents in ${Object.keys(documentCounts).length} containers`);
  } catch (err: any) {
    finishedRun = { ...run, status: 'failed', finishedAt: new Date().toISOString(), error: String(err?.message ?? err).slice(0, 500) };
    console.error('[backup] failed:', err);
  }

  const current = await readStatusDoc().catch(() => null);
  await writeStatusDoc({
    id: STATUS_DOC_ID,
    lastSuccessAt: lastSuccessAt ?? current?.lastSuccessAt ?? null,
    lastAttemptAt: run.startedAt,
    lastRun: finishedRun,
  }).catch(err => console.error('[backup] could not record status:', err));

  if (finishedRun.status === 'succeeded') {
    try {
      const pruned = await pruneOldBackups();
      if (pruned.length) console.log(`[backup] pruned ${pruned.length} old backup(s): ${pruned.join(', ')}`);
    } catch (err) {
      console.error('[backup] pruning failed:', err);
    }
  }
}

/**
 * Starts a backup in the background if one may start now. Resolves once the
 * run is claimed (not when it finishes) with the claimed run, or null when one
 * is already running or — for a scheduled trigger — none is due.
 */
export async function startBackup(trigger: DatabaseBackupTrigger, requestedBy?: string): Promise<DatabaseBackupRun | null> {
  if (localRun) return null;
  const run = await claimRun(trigger, requestedBy, new Date());
  if (!run) return null;
  localRun = executeRun(run).finally(() => { localRun = null; });
  return run;
}

export async function getBackupStatus(): Promise<DatabaseBackupStatus> {
  const [doc, blobs] = await Promise.all([readStatusDoc(), listBlobsWithPrefix(BACKUP_PREFIX)]);
  const backups: DatabaseBackupFile[] = blobs
    .filter(b => isBackupBlobName(b.name))
    .sort((a, b) => b.name.localeCompare(a.name))
    .map(b => ({ name: b.name, createdAt: b.createdOn?.toISOString() ?? null, sizeBytes: b.sizeBytes ?? null }));
  const lastSuccessAt = doc?.lastSuccessAt ?? null;
  return {
    running: !!localRun || isRunInProgress(doc?.lastRun, new Date()),
    lastSuccessAt,
    nextScheduledAt: lastSuccessAt ? new Date(new Date(lastSuccessAt).getTime() + BACKUP_INTERVAL_MS).toISOString() : null,
    lastRun: doc?.lastRun ?? null,
    backups,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

async function scheduledCheck(): Promise<void> {
  try {
    await startBackup('scheduled');
  } catch (err) {
    console.error('[backup] scheduled check failed:', err);
  }
}

/**
 * Checks hourly whether a week has passed since the last successful backup.
 * Driven by the stored last-success time rather than a fixed clock, so a
 * restart or a few days of downtime never skips a week. Set
 * DATABASE_BACKUPS_DISABLED=true to turn it off (e.g. a local dev server that
 * shares production's database).
 */
export function startBackupScheduler(): void {
  if (process.env['DATABASE_BACKUPS_DISABLED'] === 'true') {
    console.log('[backup] scheduler disabled by DATABASE_BACKUPS_DISABLED');
    return;
  }
  if (schedulerTimer) return;
  setTimeout(scheduledCheck, FIRST_CHECK_DELAY_MS).unref();
  schedulerTimer = setInterval(scheduledCheck, CHECK_INTERVAL_MS);
  schedulerTimer.unref();
}
