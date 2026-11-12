/** One backup zip in blob storage. */
export interface DatabaseBackupFile {
  /** Blob name, e.g. "backups/quill-backup-2026-11-12T03-00-00Z.zip". */
  name: string;
  createdAt: string | null;
  sizeBytes: number | null;
}

export type DatabaseBackupTrigger = 'scheduled' | 'manual';

/** Outcome of the most recent backup attempt. */
export interface DatabaseBackupRun {
  trigger: DatabaseBackupTrigger;
  requestedBy?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'succeeded' | 'failed';
  blobName?: string;
  /** Documents written per container. */
  documentCounts?: Record<string, number>;
  error?: string;
}

export interface DatabaseBackupStatus {
  running: boolean;
  lastSuccessAt: string | null;
  nextScheduledAt: string | null;
  lastRun: DatabaseBackupRun | null;
  backups: DatabaseBackupFile[];
  /** The restore in progress, or the last one since the server started. */
  restore: DatabaseRestoreRun | null;
}

/** Per-container result of a restore, or of its preview. */
export interface DatabaseRestoreContainer {
  id: string;
  inBackup: number;
  /** Documents whose id is not in the database — what a restore would add. */
  toCreate: number;
  /** Documents whose id already exists — a restore skips these, never overwriting. */
  alreadyExist: number;
  /** The container itself isn't in the database and would be created. */
  containerMissing: boolean;
  /** Filled in as a restore runs. */
  created?: number;
  skipped?: number;
}

export interface DatabaseRestorePreview {
  backupName: string;
  backupCreatedAt: string;
  sourceDatabase: string;
  containers: DatabaseRestoreContainer[];
  totals: { inBackup: number; toCreate: number; alreadyExist: number };
}

export interface DatabaseRestoreRun {
  backupName: string;
  requestedBy: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'succeeded' | 'failed';
  containers: DatabaseRestoreContainer[];
  created: number;
  skipped: number;
  error?: string;
}
