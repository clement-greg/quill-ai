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

/** A tag in use on the caller's thoughts, with how many thoughts carry it. */
export interface ThoughtTagCount {
  tag: string;
  count: number;
}

/** One page of the thoughts list, as returned by `GET /api/thoughts`. */
export interface ThoughtPage {
  items: Thought[];
  /** Thoughts matching the tag filter, across all pages. */
  total: number;
  /** Every tag on the caller's thoughts (ignoring the filter), alphabetical. */
  tags: ThoughtTagCount[];
}

/** Page sizes offered in the thoughts list; the smallest is also the default. */
export const THOUGHT_PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;
export const DEFAULT_THOUGHT_PAGE_SIZE = THOUGHT_PAGE_SIZE_OPTIONS[0];
export const MAX_THOUGHT_PAGE_SIZE = THOUGHT_PAGE_SIZE_OPTIONS[THOUGHT_PAGE_SIZE_OPTIONS.length - 1];

export const MAX_THOUGHT_TAGS = 20;
export const MAX_THOUGHT_TAG_LENGTH = 40;

/**
 * Cleans a tag list: trims and collapses whitespace, drops commas (the filter
 * query separates tags with them), drops empties, caps each tag's length, and
 * removes case-insensitive duplicates keeping the first spelling.
 */
export function normalizeThoughtTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_THOUGHT_TAG_LENGTH).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_THOUGHT_TAGS) break;
  }
  return out;
}
