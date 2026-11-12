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
}
