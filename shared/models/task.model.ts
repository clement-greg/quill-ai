import { AuditedRecord } from './audited-record';

/**
 * Tasks share the `thought-items` container with thoughts (the Cosmos database
 * is at its container ceiling). The two are told apart by `docType`: thoughts
 * have none (or 'thought'), tasks always carry 'task'. Every thought query must
 * filter on THOUGHT_DOC_TYPE and every task query on TASK_DOC_TYPE so neither
 * kind leaks into the other's screens, search, or chat tools.
 */
export const THOUGHT_DOC_TYPE = 'thought';
export const TASK_DOC_TYPE = 'task';

/** A phrase in a task's body that refers to an entity or chapter, found by the LLM. */
export interface TaskLink {
  kind: 'entity' | 'chapter';
  /** Id of the entity or chapter the phrase refers to. */
  id: string;
  /** The phrase exactly as it appears in the body (matched case-insensitively when rendering). */
  text: string;
  /** Display name of the target, for tooltips. */
  name?: string;
}

export interface Task extends AuditedRecord {
  id: string;
  docType: typeof TASK_DOC_TYPE;
  bookId: string;
  /** Series of the book, cached so entity links can be resolved without another read. */
  seriesId?: string;
  title: string;
  body?: string;
  /** Calendar date the task is due, `YYYY-MM-DD` (no time zone). */
  dueDate?: string;
  completed: boolean;
  completedAt?: string;
  /** Chapter whose save completed the task, when it was completed from the editor prompt. */
  completedChapterId?: string;
  links?: TaskLink[];
  deleted?: boolean;
}

/** A task as returned by the list endpoints: the stored task plus the book's title. */
export interface TaskListItem extends Task {
  bookTitle?: string;
}

export type TaskStatusFilter = 'open' | 'completed' | 'all';

/** A book a task can be filed under. */
export interface TaskBookOption {
  id: string;
  title: string;
  seriesId?: string;
}

/** Response of `GET /api/tasks`. */
export interface TaskPage {
  items: TaskListItem[];
  total: number;
  /** The caller's books, for the book picker and filter. */
  books: TaskBookOption[];
  /** The book the caller last edited a chapter in: the default for a new task. */
  lastEditedBookId?: string | null;
}

/** Response of `GET /api/tasks/summary`, for the home tile and Siri. */
export interface TaskSummary {
  open: number;
  overdue: number;
  dueThisWeek: number;
  /** The most pressing open tasks: overdue and soonest due first, undated last. */
  next: TaskListItem[];
}

/** A task the LLM thinks a chapter save may have fulfilled. */
export interface TaskFulfillmentCandidate {
  taskId: string;
  title: string;
  reason: string;
}

export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_TASK_BODY_LENGTH = 4000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns `value` when it is a real `YYYY-MM-DD` calendar date, else undefined. */
export function normalizeDueDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = DATE_RE.exec(value.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  return value.trim();
}

/** Today's date as `YYYY-MM-DD` in the given IANA time zone (falls back to UTC on a bad zone). */
export function todayIn(timeZone?: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Adds whole days to a `YYYY-MM-DD` date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const out = new Date(Date.UTC(y, m - 1, d + days));
  return out.toISOString().slice(0, 10);
}

/**
 * Orders open tasks by urgency: dated tasks soonest first (overdue at the top),
 * undated after, newest-created first among equals.
 */
export function compareOpenTasks(a: Pick<Task, 'dueDate' | 'createdAt'>, b: Pick<Task, 'dueDate' | 'createdAt'>): number {
  if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.dueDate && !b.dueDate) return -1;
  if (!a.dueDate && b.dueDate) return 1;
  return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
}

/** A run of a task body: plain text, or a phrase linked to an entity or chapter. */
export interface TaskBodySegment {
  text: string;
  link?: TaskLink;
}

/**
 * Splits a task body into plain and linked runs. Every whole-word,
 * case-insensitive occurrence of a link's phrase is linked; where phrases
 * overlap the longest wins.
 */
export function segmentTaskBody(body: string, links: TaskLink[] | undefined): TaskBodySegment[] {
  if (!body) return [];
  const usable = (links ?? []).filter(l => l.text?.trim());
  if (!usable.length) return [{ text: body }];
  const byPhrase = new Map<string, TaskLink>();
  for (const l of [...usable].sort((a, b) => b.text.length - a.text.length)) {
    const key = l.text.trim().toLowerCase();
    if (!byPhrase.has(key)) byPhrase.set(key, l);
  }
  const escaped = [...byPhrase.keys()].map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const out: TaskBodySegment[] = [];
  let last = 0;
  for (const m of body.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: body.slice(last, start) });
    out.push({ text: m[0], link: byPhrase.get(m[0].toLowerCase()) });
    last = start + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out;
}
