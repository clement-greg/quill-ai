/**
 * Tasks: per-book to-dos with a due date, stored in the `thought-items`
 * container beside thoughts (told apart by `docType`, see task.model.ts).
 *
 * Besides storage this holds the three LLM jobs tasks need:
 *   - linking: find the characters, places, things and chapters a task's body
 *     mentions, so the UI can link them;
 *   - fulfillment: given what a chapter save changed, guess which of the book's
 *     open tasks it may have finished, so the editor can offer to complete them;
 *   - spoken tasks: turn a sentence said to Siri into a title, book and due date.
 * Every LLM call degrades gracefully: linking falls back to plain name matching,
 * the other two return nothing.
 */
import { randomUUID } from 'crypto';
import { AzureOpenAI } from 'openai';
import config from '../config';
import { getContainer } from './cosmos';
import { modelFor, AiModelUser } from './ai-models';
import { withOwnerFilter } from '../middleware/owner-guard';
import { entityNameForms } from './entity-name-match';
import {
  Task,
  TaskBookOption,
  TaskFulfillmentCandidate,
  TaskLink,
  TaskListItem,
  TaskStatusFilter,
  TaskSummary,
  TASK_DOC_TYPE,
  MAX_TASK_BODY_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  addDays,
  compareOpenTasks,
  normalizeDueDate,
} from '../../shared/models/task.model';

const CONTAINER = 'thought-items';
const NOT_HIDDEN = '(NOT IS_DEFINED(c.archived) OR c.archived = false) AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)';
const NOT_DELETED = '(NOT IS_DEFINED(c.deleted) OR c.deleted = false)';

let client: AzureOpenAI | null = null;
function llm(): AzureOpenAI {
  client ??= new AzureOpenAI({
    endpoint: config.foundry.endpoint,
    apiKey: config.foundry.key,
    apiVersion: config.foundry.apiVersion,
  });
  return client;
}

/** Runs a JSON-mode completion and parses the object it returns (null on any failure). */
async function completeJson(user: AiModelUser | undefined, system: string, input: string): Promise<Record<string, unknown> | null> {
  const completion = await llm().chat.completions.create({
    model: await modelFor(user, 'tasks'),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input },
    ],
    response_format: { type: 'json_object' },
  });
  const raw = completion.choices[0]?.message?.content;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// ── Books ────────────────────────────────────────────────────────────────────

/** The owner's live books, alphabetical, for the picker and title lookups. */
export async function listTaskBooks(owner: string): Promise<TaskBookOption[]> {
  const { resources } = await getContainer('books')
    .items.query<TaskBookOption>(withOwnerFilter(owner, `SELECT c.id, c.title, c.seriesId FROM c WHERE ${NOT_HIDDEN}`))
    .fetchAll();
  return resources
    .filter(b => b.title)
    .map(b => ({ id: b.id, title: b.title, seriesId: b.seriesId }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

/** Best title match among the books (≥ 0.5), mirroring the chat's navigation matching. */
export function matchBookByTitle(books: TaskBookOption[], name: string): TaskBookOption | null {
  const query = name.trim().toLowerCase().replace(/^the\s+/, '');
  if (!query) return null;
  const tokens = (s: string) => new Set(s.split(/\W+/).filter(Boolean));
  const queryTokens = tokens(query);
  let best: { book: TaskBookOption; score: number } | null = null;
  for (const book of books) {
    const t = book.title.trim().toLowerCase().replace(/^the\s+/, '');
    let score: number;
    if (t === query) score = 1;
    else if (t.includes(query) || query.includes(t)) score = 0.85;
    else {
      const tt = tokens(t);
      let inter = 0;
      for (const x of queryTokens) if (tt.has(x)) inter++;
      score = tt.size && queryTokens.size ? inter / Math.max(tt.size, queryTokens.size) : 0;
    }
    if (score > (best?.score ?? 0)) best = { book, score };
  }
  return best && best.score >= 0.5 ? best.book : null;
}

/** Newest version snapshots checked when looking for the last-edited book. */
const RECENT_EDIT_SCAN = 25;

/**
 * The book the owner most recently edited, among `books`: the book of their
 * newest chapter save (version snapshot), else of their most recently modified
 * chapter. Used as the default book when a task doesn't name one. Null when
 * they haven't edited anything in these books.
 */
export async function lastEditedBookId(owner: string, books: TaskBookOption[]): Promise<string | null> {
  if (!books.length) return null;
  const owned = new Set(books.map(b => b.id));
  const chapters = getContainer('chapters');
  try {
    const { resources: versions } = await getContainer('chapter-versions')
      .items.query<{ chapterId: string }>(withOwnerFilter(owner, {
        query:
          `SELECT TOP ${RECENT_EDIT_SCAN} c.chapterId FROM c ` +
          'WHERE (NOT IS_DEFINED(c.docType) OR c.docType = @docType) ORDER BY c.savedAt DESC',
        parameters: [{ name: '@docType', value: 'version' }],
      }))
      .fetchAll();
    const tried = new Set<string>();
    for (const { chapterId } of versions) {
      if (!chapterId || tried.has(chapterId)) continue;
      tried.add(chapterId);
      const { resource } = await chapters.item(chapterId, chapterId).read<{ bookId?: string }>().catch(() => ({ resource: undefined }));
      if (resource?.bookId && owned.has(resource.bookId)) return resource.bookId;
    }
  } catch (err) {
    console.warn('tasks: could not read recent chapter saves:', err);
  }
  try {
    const { resources } = await chapters
      .items.query<{ bookId?: string }>(withOwnerFilter(owner, `SELECT TOP 50 c.bookId FROM c WHERE ${NOT_HIDDEN} ORDER BY c.modifiedAt DESC`))
      .fetchAll();
    return resources.find(c => c.bookId && owned.has(c.bookId))?.bookId ?? null;
  } catch (err) {
    console.warn('tasks: could not read recent chapters:', err);
    return null;
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** All of the owner's non-deleted tasks, optionally for one book. */
export async function queryTasks(owner: string, bookId?: string): Promise<Task[]> {
  const parameters = [
    { name: '@owner', value: owner },
    { name: '@docType', value: TASK_DOC_TYPE },
    ...(bookId ? [{ name: '@bookId', value: bookId }] : []),
  ];
  const { resources } = await getContainer(CONTAINER)
    .items.query<Task>({
      query:
        `SELECT * FROM c WHERE c.owner = @owner AND c.docType = @docType AND ${NOT_DELETED}` +
        (bookId ? ' AND c.bookId = @bookId' : ''),
      parameters,
    })
    .fetchAll();
  return resources;
}

/** Reads one of the owner's tasks; null if missing, someone else's, or not a task. */
export async function readTask(owner: string, id: string): Promise<Task | null> {
  try {
    const { resource } = await getContainer(CONTAINER).item(id, id).read<Task>();
    if (!resource || resource.owner !== owner || resource.docType !== TASK_DOC_TYPE) return null;
    return resource;
  } catch (err) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
}

export async function replaceTask(task: Task): Promise<Task> {
  const { resource } = await getContainer(CONTAINER).item(task.id, task.id).replace<Task>(task);
  return resource ?? task;
}

/** Filters and orders tasks for a list: open by urgency, completed newest first, all = open then completed. */
export function orderTasks(tasks: Task[], status: TaskStatusFilter): Task[] {
  const open = tasks.filter(t => !t.completed).sort(compareOpenTasks);
  const done = tasks
    .filter(t => t.completed)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  if (status === 'open') return open;
  if (status === 'completed') return done;
  return [...open, ...done];
}

/** Lower-cased words of 2+ characters every one of which must appear in the title or body. */
export function matchesTaskSearch(task: Pick<Task, 'title' | 'body'>, q: string): boolean {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(w => w.length >= 2);
  if (!words.length) return true;
  const haystack = `${task.title}\n${task.body ?? ''}`.toLowerCase();
  return words.every(w => haystack.includes(w));
}

export function withBookTitles(tasks: Task[], books: TaskBookOption[]): TaskListItem[] {
  const titles = new Map(books.map(b => [b.id, b.title]));
  return tasks.map(t => ({ ...t, bookTitle: titles.get(t.bookId) }));
}

export function summarizeTasks(tasks: Task[], books: TaskBookOption[], today: string, nextCount = 5): TaskSummary {
  const open = orderTasks(tasks, 'open');
  const weekEnd = addDays(today, 7);
  return {
    open: open.length,
    overdue: open.filter(t => t.dueDate && t.dueDate < today).length,
    dueThisWeek: open.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= weekEnd).length,
    next: withBookTitles(open.slice(0, nextCount), books),
  };
}

export interface TaskInput {
  title?: unknown;
  body?: unknown;
  bookId?: unknown;
  dueDate?: unknown;
}

export type TaskInputResult =
  | { ok: true; title: string; body?: string; book: TaskBookOption; dueDate?: string; dueDateCleared: boolean }
  | { ok: false; error: string };

/**
 * Validates create/update fields. `existing` supplies defaults for an update,
 * so only the fields sent are changed; a dueDate of null or '' clears it.
 */
export function readTaskInput(input: TaskInput, books: TaskBookOption[], existing?: Task): TaskInputResult {
  const title = input.title === undefined ? existing?.title ?? '' : String(input.title ?? '').trim();
  if (!title) return { ok: false, error: 'title is required' };
  if (title.length > MAX_TASK_TITLE_LENGTH) return { ok: false, error: 'title is too long' };

  const body = input.body === undefined ? existing?.body : String(input.body ?? '').trim() || undefined;
  if (body && body.length > MAX_TASK_BODY_LENGTH) return { ok: false, error: 'body is too long' };

  const bookId = input.bookId === undefined ? existing?.bookId : String(input.bookId ?? '');
  const book = books.find(b => b.id === bookId);
  if (!book) return { ok: false, error: bookId ? 'book not found' : 'bookId is required' };

  const dueDateCleared = input.dueDate === null || input.dueDate === '';
  let dueDate: string | undefined;
  if (input.dueDate === undefined) dueDate = existing?.dueDate;
  else if (!dueDateCleared) {
    dueDate = normalizeDueDate(input.dueDate);
    if (!dueDate) return { ok: false, error: 'dueDate must be a YYYY-MM-DD date' };
  }
  return { ok: true, title, body, book, dueDate, dueDateCleared };
}

/** Creates a task, linking its body to the entities and chapters it mentions. */
export async function createTask(
  user: AiModelUser & { email: string },
  fields: { title: string; body?: string; book: TaskBookOption; dueDate?: string },
): Promise<Task> {
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    docType: TASK_DOC_TYPE,
    bookId: fields.book.id,
    seriesId: fields.book.seriesId,
    title: fields.title,
    ...(fields.body ? { body: fields.body } : {}),
    ...(fields.dueDate ? { dueDate: fields.dueDate } : {}),
    completed: false,
    links: await linkTaskBody(user, fields.body, fields.book),
    owner: user.email,
    createdBy: user.email,
    createdAt: now,
    modifiedBy: user.email,
    modifiedAt: now,
  };
  const { resource } = await getContainer(CONTAINER).items.create<Task>(task);
  return resource ?? task;
}

/** Marks a task complete (or reopens it), recording the chapter whose save finished it. */
export async function setTaskCompleted(owner: string, task: Task, completed: boolean, chapterId?: string): Promise<Task> {
  const now = new Date().toISOString();
  const updated: Task = { ...task, completed, modifiedBy: owner, modifiedAt: now };
  if (completed) {
    updated.completedAt = task.completed ? task.completedAt ?? now : now;
    if (chapterId) updated.completedChapterId = chapterId;
  } else {
    delete updated.completedAt;
    delete updated.completedChapterId;
  }
  return replaceTask(updated);
}

// ── Linking ──────────────────────────────────────────────────────────────────

type LinkEntity = { id: string; name: string; type?: string; firstName?: string; lastName?: string; nickname?: string; title?: string; aliases?: string[] };
type LinkChapter = { id: string; title?: string; sortOrder?: number };

/** Most candidates of each kind offered to the model. */
const MAX_LINK_CANDIDATES = 400;

async function linkCandidates(book: TaskBookOption): Promise<{ entities: LinkEntity[]; chapters: LinkChapter[] }> {
  const [entities, chapters] = await Promise.all([
    book.seriesId
      ? getContainer('entities')
          .items.query<LinkEntity>({
            query:
              'SELECT c.id, c.name, c.type, c.firstName, c.lastName, c.nickname, c.title, c.aliases FROM c ' +
              `WHERE c.seriesId = @seriesId AND ${NOT_HIDDEN}`,
            parameters: [{ name: '@seriesId', value: book.seriesId }],
          })
          .fetchAll()
          .then(r => r.resources)
      : Promise.resolve([] as LinkEntity[]),
    getContainer('chapters')
      .items.query<LinkChapter>({
        query: `SELECT c.id, c.title, c.sortOrder FROM c WHERE c.bookId = @bookId AND ${NOT_HIDDEN}`,
        parameters: [{ name: '@bookId', value: book.id }],
      })
      .fetchAll()
      .then(r => r.resources),
  ]);
  return {
    entities: entities.filter(e => e.name).slice(0, MAX_LINK_CANDIDATES),
    chapters: [...chapters].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).slice(0, MAX_LINK_CANDIDATES),
  };
}

const LINK_SYSTEM_PROMPT =
  'You link a writer\'s to-do note to the story elements it mentions. You are given the note and two ' +
  'numbered lists from the writer\'s book: ENTITIES (characters, places, things, with their other names) ' +
  'and CHAPTERS (in reading order, so "chapter 3" or "the third chapter" means the third one listed). ' +
  'Find every phrase in the note that refers to one of them — by name, nickname, alias, partial name ' +
  '("Dale" for "Dale Harper"), chapter title, or chapter number. Copy each phrase EXACTLY as it is written ' +
  'in the note (same spelling; it must be a substring of the note). Do not link generic words ("the town", ' +
  '"a chapter") unless they unmistakably name one element, and never guess between two elements with the ' +
  'same name. Return JSON: {"links":[{"ref":"E3","text":"Dale"},{"ref":"C2","text":"chapter 2"}]} and ' +
  '{"links":[]} when nothing matches.';

/** Plain name matching, used when the model is unavailable. */
export function fallbackLinks(body: string, entities: LinkEntity[], chapters: LinkChapter[]): TaskLink[] {
  const links: TaskLink[] = [];
  const seen = new Set<string>();
  const add = (link: TaskLink) => {
    const key = link.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };
  const forms: { text: string; entity: LinkEntity }[] = [];
  for (const e of entities) for (const f of entityNameForms(e)) if (f.length >= 3) forms.push({ text: f, entity: e });
  forms.sort((a, b) => b.text.length - a.text.length);
  // Longest forms first; a shorter form inside text already linked ("Dale" in "Dale Harper") is skipped.
  const claimed: [number, number][] = [];
  for (const { text, entity } of forms) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of body.matchAll(pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (claimed.some(([a, b]) => start < b && end > a)) continue;
      claimed.push([start, end]);
      add({ kind: 'entity', id: entity.id, text: m[0], name: entity.name });
    }
  }
  for (const m of body.matchAll(/\bchapter\s+(\d{1,3})\b/gi)) {
    const chapter = chapters[Number(m[1]) - 1];
    if (chapter) add({ kind: 'chapter', id: chapter.id, text: m[0], name: chapter.title });
  }
  return links;
}

/**
 * Finds the entities and chapters a task body mentions. Each link's phrase is
 * checked against the body and its target against the candidates, so the
 * model can't link text that isn't there or an element that doesn't exist.
 */
export async function linkTaskBody(
  user: AiModelUser & { email: string },
  body: string | undefined,
  book: TaskBookOption,
): Promise<TaskLink[]> {
  if (!body?.trim()) return [];
  let candidates: { entities: LinkEntity[]; chapters: LinkChapter[] };
  try {
    candidates = await linkCandidates(book);
  } catch (err) {
    console.warn('tasks: could not load link candidates:', err);
    return [];
  }
  const { entities, chapters } = candidates;
  if (!entities.length && !chapters.length) return [];

  const entityLines = entities.map((e, i) => {
    const others = entityNameForms(e).filter(f => f !== e.name);
    return `E${i + 1}: ${e.name}${e.type ? ` (${e.type.toLowerCase()})` : ''}${others.length ? ` — also: ${[...new Set(others)].join(', ')}` : ''}`;
  });
  const chapterLines = chapters.map((c, i) => `C${i + 1}: chapter ${i + 1}${c.title ? ` — "${c.title}"` : ''}`);
  const input = `NOTE:\n${body}\n\nENTITIES:\n${entityLines.join('\n') || '(none)'}\n\nCHAPTERS:\n${chapterLines.join('\n') || '(none)'}`;

  try {
    const parsed = await completeJson(user, LINK_SYSTEM_PROMPT, input);
    const raw = Array.isArray(parsed?.['links']) ? (parsed!['links'] as unknown[]) : [];
    const lowerBody = body.toLowerCase();
    const links: TaskLink[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const ref = String((item as { ref?: unknown })?.ref ?? '').trim().toUpperCase();
      const text = String((item as { text?: unknown })?.text ?? '').trim();
      if (!text || !lowerBody.includes(text.toLowerCase()) || seen.has(text.toLowerCase())) continue;
      const index = Number(ref.slice(1)) - 1;
      // "chapter 3" / "ch. 3" means the third chapter, whatever ref the model picked.
      const numbered = /^(?:chapter|ch\.?)\s*(\d{1,3})$/i.exec(text);
      if (numbered) {
        const chapter = chapters[Number(numbered[1]) - 1];
        if (chapter) {
          links.push({ kind: 'chapter', id: chapter.id, text, name: chapter.title });
          seen.add(text.toLowerCase());
        }
        continue;
      }
      if (ref.startsWith('E') && entities[index]) {
        links.push({ kind: 'entity', id: entities[index].id, text, name: entities[index].name });
      } else if (ref.startsWith('C') && chapters[index]) {
        links.push({ kind: 'chapter', id: chapters[index].id, text, name: chapters[index].title });
      } else continue;
      seen.add(text.toLowerCase());
    }
    return links;
  } catch (err) {
    console.warn('tasks: link model failed, using name matching:', err);
    return fallbackLinks(body, entities, chapters);
  }
}

// ── Chapter-save fulfillment ─────────────────────────────────────────────────

/** HTML to plain paragraphs. */
export function plainParagraphs(html: string): string[] {
  return (html ?? '')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split(/\n{2,}/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Paragraphs added or reworded by a save, and paragraphs it removed. */
export function chapterChanges(previousHtml: string, html: string): { added: string[]; removed: string[] } {
  const before = plainParagraphs(previousHtml);
  const after = plainParagraphs(html);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter(p => !beforeSet.has(p)),
    removed: before.filter(p => !afterSet.has(p)),
  };
}

function capJoin(paragraphs: string[], maxChars: number): string {
  let out = '';
  for (const p of paragraphs) {
    if (out.length + p.length > maxChars) {
      out += `${out ? '\n\n' : ''}${p.slice(0, Math.max(0, maxChars - out.length))}…`;
      break;
    }
    out += `${out ? '\n\n' : ''}${p}`;
  }
  return out;
}

const FULFILL_SYSTEM_PROMPT =
  'An author just saved a chapter of their novel. You are given their open to-do TASKS for this book and ' +
  'the text the save ADDED OR CHANGED (and any text it REMOVED). Decide which tasks these edits plausibly ' +
  'complete. A task is complete only when the changes themselves clearly do what it asks (e.g. "add a ' +
  'scene where Mara finds the letter" and the added text has Mara finding the letter; "cut the dream ' +
  'sequence" and the removed text is the dream). Do not mark a task because the chapter merely mentions ' +
  'the same character or topic, and ignore tasks about other chapters unless the changes clearly do them. ' +
  'Return JSON: {"fulfilled":[{"task":"T2","confidence":0.0-1.0,"reason":"one short sentence citing what ' +
  'changed"}]} — {"fulfilled":[]} when none apply.';

/** Lowest model confidence at which the author is asked about a task. */
const FULFILL_MIN_CONFIDENCE = 0.6;
const MAX_FULFILL_TASKS = 40;

/**
 * Asks the model which of the owner's open tasks for the chapter's book a save
 * may have completed. Returns [] when nothing changed, the book has no open
 * tasks, or the model fails.
 */
export async function findFulfilledTasks(
  user: AiModelUser & { email: string },
  chapter: { id: string; bookId: string; title?: string },
  previousHtml: string,
  html: string,
  excludeTaskIds: string[] = [],
): Promise<TaskFulfillmentCandidate[]> {
  const { added, removed } = chapterChanges(previousHtml, html);
  if (!added.length && !removed.length) return [];

  const exclude = new Set(excludeTaskIds);
  const open = orderTasks(await queryTasks(user.email, chapter.bookId), 'open')
    .filter(t => !exclude.has(t.id))
    .slice(0, MAX_FULFILL_TASKS);
  if (!open.length) return [];

  const taskLines = open.map((t, i) => {
    const body = t.body ? ` — ${t.body.replace(/\s+/g, ' ').slice(0, 500)}` : '';
    return `T${i + 1}: ${t.title}${body}`;
  });
  const input =
    `CHAPTER: ${chapter.title ?? '(untitled)'}\n\nTASKS:\n${taskLines.join('\n')}\n\n` +
    `ADDED OR CHANGED:\n${capJoin(added, 12000) || '(nothing)'}\n\n` +
    `REMOVED:\n${capJoin(removed, 3000) || '(nothing)'}`;

  try {
    const parsed = await completeJson(user, FULFILL_SYSTEM_PROMPT, input);
    const raw = Array.isArray(parsed?.['fulfilled']) ? (parsed!['fulfilled'] as unknown[]) : [];
    const out: TaskFulfillmentCandidate[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const ref = String((item as { task?: unknown })?.task ?? '').trim().toUpperCase();
      const confidence = Number((item as { confidence?: unknown })?.confidence ?? 0);
      const task = ref.startsWith('T') ? open[Number(ref.slice(1)) - 1] : undefined;
      if (!task || seen.has(task.id) || !(confidence >= FULFILL_MIN_CONFIDENCE)) continue;
      seen.add(task.id);
      out.push({
        taskId: task.id,
        title: task.title,
        reason: String((item as { reason?: unknown })?.reason ?? '').trim().slice(0, 300),
      });
    }
    return out;
  } catch (err) {
    console.warn('tasks: fulfillment check failed:', err);
    return [];
  }
}

// ── Spoken tasks ─────────────────────────────────────────────────────────────

export interface ParsedSpokenTask {
  title: string;
  body?: string;
  bookId?: string;
  dueDate?: string;
}

function spokenTaskPrompt(today: string): string {
  const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  return (
    'A novelist dictated a to-do item for one of their books. Turn it into a task. Today is ' +
    `${weekday}, ${today}. Return JSON {"title":"…","body":"…","book":"B2","dueDate":"YYYY-MM-DD"}: ` +
    '"title" is a short imperative summary (under 80 characters); "body" is any further detail the author ' +
    'gave, in their words, or "" when the title says it all; "book" is the ref of the book they named from ' +
    'the BOOKS list, or null when they did not clearly name one (or there is no list); "dueDate" is the ' +
    'date they gave, resolved against today ("Friday" means the coming Friday, "next week" means a week from ' +
    'today, "end of the month" means its last day), or null when they gave none. Leave the book and date ' +
    'phrases out of the title.'
  );
}

/** Reads a spoken sentence into task fields. Null when the model fails or finds no task. */
export async function parseSpokenTask(
  user: AiModelUser | undefined,
  text: string,
  books: TaskBookOption[],
  today: string,
): Promise<ParsedSpokenTask | null> {
  const bookLines = books.map((b, i) => `B${i + 1}: ${b.title}`).join('\n');
  try {
    const parsed = await completeJson(user, spokenTaskPrompt(today), `BOOKS:\n${bookLines || '(none)'}\n\nDICTATED:\n${text}`);
    if (!parsed) return null;
    const title = String(parsed['title'] ?? '').trim().slice(0, MAX_TASK_TITLE_LENGTH);
    if (!title) return null;
    const body = String(parsed['body'] ?? '').trim() || undefined;
    const ref = String(parsed['book'] ?? '').trim().toUpperCase();
    const book = ref.startsWith('B') ? books[Number(ref.slice(1)) - 1] : undefined;
    return { title, body, bookId: book?.id, dueDate: normalizeDueDate(parsed['dueDate']) };
  } catch (err) {
    console.warn('tasks: spoken task parse failed:', err);
    return null;
  }
}
