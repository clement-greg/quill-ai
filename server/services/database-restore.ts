/**
 * Restores a backup into the live database — insert-only. A document whose id
 * already exists is skipped, never overwritten, so a restore can only add back
 * what is missing. Ids are kept as-is because documents reference each other
 * by id. Containers missing from the database are recreated from the backup's
 * manifest definition.
 *
 * One restore runs at a time, in the background; its progress is held in
 * memory and reported through GET /api/backups.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createContainerIfMissing, getContainer, listContainerDefinitions } from './cosmos';
import { downloadBlobStreamRaw } from './storage';
import { openBackupArchive, BackupArchive } from './backup-archive';
import {
  DatabaseRestoreContainer,
  DatabaseRestorePreview,
  DatabaseRestoreRun,
} from '../../shared/models/database-backup.model';

let currentRestore: DatabaseRestoreRun | null = null;

export function getRestoreRun(): DatabaseRestoreRun | null {
  return currentRestore;
}

export function isRestoreRunning(): boolean {
  return currentRestore?.status === 'running';
}

/** Downloads the backup to a temp file (the zip reader needs random access) and opens it. */
async function withArchive<T>(blobName: string, fn: (archive: BackupArchive) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'quill-restore-'));
  const file = path.join(dir, 'backup.zip');
  try {
    const { stream } = await downloadBlobStreamRaw(blobName);
    await pipeline(stream, fs.createWriteStream(file));
    const archive = await openBackupArchive(file);
    try {
      return await fn(archive);
    } finally {
      archive.close();
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function existingIds(containerId: string): Promise<Set<string>> {
  const { resources } = await getContainer(containerId).items
    .query<string>('SELECT VALUE c.id FROM c')
    .fetchAll();
  return new Set(resources);
}

async function buildPreview(blobName: string, archive: BackupArchive): Promise<DatabaseRestorePreview> {
  const live = new Set((await listContainerDefinitions()).map(d => d.id));
  const containers: DatabaseRestoreContainer[] = [];
  for (const c of archive.manifest.containers) {
    const id = c.definition.id;
    const containerMissing = !live.has(id);
    const ids = containerMissing ? new Set<string>() : await existingIds(id);
    let inBackup = 0;
    let alreadyExist = 0;
    for await (const doc of archive.documents(c.file)) {
      inBackup++;
      if (ids.has(doc['id'] as string)) alreadyExist++;
    }
    containers.push({ id, inBackup, alreadyExist, toCreate: inBackup - alreadyExist, containerMissing });
  }
  const sum = (k: 'inBackup' | 'toCreate' | 'alreadyExist') => containers.reduce((a, c) => a + c[k], 0);
  return {
    backupName: blobName,
    backupCreatedAt: archive.manifest.createdAt,
    sourceDatabase: archive.manifest.database,
    containers,
    totals: { inBackup: sum('inBackup'), toCreate: sum('toCreate'), alreadyExist: sum('alreadyExist') },
  };
}

/** What a restore of this backup would add and skip, without writing anything. */
export function previewRestore(blobName: string): Promise<DatabaseRestorePreview> {
  return withArchive(blobName, archive => buildPreview(blobName, archive));
}

async function executeRestore(run: DatabaseRestoreRun): Promise<void> {
  console.log(`[restore] started from ${run.backupName} by ${run.requestedBy}`);
  try {
    await withArchive(run.backupName, async archive => {
      const live = new Set((await listContainerDefinitions()).map(d => d.id));
      run.containers = archive.manifest.containers.map(c => ({
        id: c.definition.id, inBackup: c.documentCount, toCreate: 0, alreadyExist: 0,
        containerMissing: !live.has(c.definition.id), created: 0, skipped: 0,
      }));
      for (const [i, c] of archive.manifest.containers.entries()) {
        const progress = run.containers[i];
        const container = progress.containerMissing
          ? await createContainerIfMissing(c.definition as any)
          : getContainer(c.definition.id);
        for await (const doc of archive.documents(c.file)) {
          try {
            await container.items.create(doc);
            progress.created!++;
            run.created++;
          } catch (err: any) {
            if (err.code !== 409) throw err; // 409: already exists — never overwrite
            progress.skipped!++;
            run.skipped++;
          }
        }
        progress.toCreate = progress.created!;
        progress.alreadyExist = progress.skipped!;
      }
    });
    run.status = 'succeeded';
    console.log(`[restore] finished: ${run.created} created, ${run.skipped} skipped`);
  } catch (err: any) {
    run.status = 'failed';
    run.error = String(err?.message ?? err).slice(0, 500);
    console.error('[restore] failed:', err);
  }
  run.finishedAt = new Date().toISOString();
}

/** Starts a restore in the background. Returns null if one is already running. */
export function startRestore(blobName: string, requestedBy: string): DatabaseRestoreRun | null {
  if (isRestoreRunning()) return null;
  const run: DatabaseRestoreRun = {
    backupName: blobName, requestedBy, startedAt: new Date().toISOString(),
    status: 'running', containers: [], created: 0, skipped: 0,
  };
  currentRestore = run;
  void executeRestore(run);
  return run;
}
