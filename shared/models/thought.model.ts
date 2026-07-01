import { AuditedRecord } from './audited-record';

export interface Thought extends AuditedRecord {
  id: string;
  title?: string;
  content: string;
  tags?: string[];
  /** 1536-dim cosine vector embedding of (title + content), for semantic search. */
  contentVector?: number[];
  deleted?: boolean;
}
