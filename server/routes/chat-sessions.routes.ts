import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import { randomUUID } from 'crypto';
import config from '../config';
import { getContainer } from '../cosmos';
import { withOwnerFilter } from '../owner-guard';
import { searchChapterChunks, reindexChapterChunks } from '../chapter-chunks';
import { Chapter, ChapterNote, OutlineItem } from '../../shared/models/chapter.model';
import { ChapterCitation } from '../../shared/models/chat-session.model';
import { BookNote } from '../../shared/models/book-note.model';
import { Book } from '../../shared/models/book.model';
import { Entity } from '../../shared/models/entity.model';
import { TimelineEvent } from '../../shared/models/timeline-event.model';
import { EntityRelationship } from '../../shared/models/entity-relationship.model';
import { generateImage } from '../image-generation';
import { buildChapterContextPrompt } from '../chapter-ai-context';
import { buildChapterDraftingContext, generateChapterBeatSheet } from '../chapter-drafting-context';

/** True when the author is asking to draft a whole chapter (vs. a small inline
 * edit/insert), e.g. "write the chapter based on the outline and notes" or
 * "give me a first draft". Routes the request to the rich drafting context. */
function isWholeChapterDraftRequest(text: string): boolean {
  const t = (text ?? '').toLowerCase();
  if (/\b(first|rough|initial)\s+draft\b/.test(t)) return true;
  return /\b(write|draft|generate|compose|create|flesh out|expand)\b[^.?!]{0,60}\bchapter\b/.test(t);
}

/** A tool the model may call. `execute` returns the result fed back to the
 * model, plus an optional `sse` payload streamed to the client as a side effect
 * (e.g. a client-side navigation instruction). `pending`, when set, is streamed
 * to the client immediately before `execute` runs — useful for long-running
 * tools (e.g. image generation) so the UI can show progress. */
interface ChatTool {
  definition: unknown;
  pending?: object;
  /** Lottie animation URL to emit after the model's final text response when this tool succeeds. */
  successLottie?: string;
  execute: (args: Record<string, unknown>) => Promise<{ toolResult: unknown; sse?: object; success?: boolean }>;
}

const router = Router();

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

const BASE_SYSTEM_PROMPT =
  'You are Quill Assistant, a helpful writing assistant. If the user asks your name, respond that you are Quill Assistant. Help the author with their creative writing, worldbuilding, character development, plot structure, dialogue, and any other writing-related questions. Format responses using markdown where appropriate.';

// Appended whenever the image tool is available. gpt-4.1-mini will happily
// answer "draw me X" with prose unless told, unambiguously, to use the tool.
const IMAGE_TOOL_GUIDANCE =
  '\n\nIMAGE GENERATION: You can create images with the generate_image tool. ' +
  'Whenever the user asks you to draw, sketch, paint, illustrate, render, design, or otherwise ' +
  'create/generate a picture, image, drawing, illustration, or artwork of something, you MUST call ' +
  'generate_image — never reply with a text description instead, and never echo the request back. ' +
  'Treat the verb "draw" (and "sketch"/"illustrate"/"paint") as an explicit request to generate an ' +
  'image. Build the tool\'s "prompt" from the user\'s description, enriching it with helpful visual ' +
  'detail while staying faithful to what they asked for.';

// Appended whenever the link_entity_references tool is available (chapter edit).
const LINK_REFERENCES_GUIDANCE =
  '\n\nLINKING ENTITY REFERENCES: When the author asks you to link, tag, mark, connect, or "make ' +
  'references" to a character/place/thing in the chapter they are editing (e.g. "link references to ' +
  'Mark Johnson", "tag every mention of John", "mark where Johnson appears"), you MUST call ' +
  'link_entity_references. Pass "entityName" as the name or alias the author used. Only pass "terms" ' +
  'when the author restricts it to a specific word or phrase (e.g. "only link \'John Markson\'", "just ' +
  'the mentions of \'the Captain\'"); otherwise omit "terms" so every name form and alias is offered. ' +
  'If the tool reports the name is ambiguous (matches more than one entity), do not guess — ask the ' +
  'author which one they mean and call the tool again with the clarified name. If it reports no match, ' +
  'tell the author and ask for the correct name. After a successful call, briefly tell the author you ' +
  'are scanning the chapter and they will be asked to confirm each set of matches.';

// Appended whenever the propose_chapter_edit tool is available (chapter edit).
const SMART_EDIT_GUIDANCE =
  '\n\nSMART EDITING: When the author asks you to add/insert, change/rewrite/reword, or remove/delete ' +
  'some content in the chapter they are editing (e.g. "add a sentence about the storm after they leave", ' +
  '"make the second paragraph more tense", "cut the line about the dog"), you MUST call ' +
  'propose_chapter_edit rather than just describing the change or returning prose. First call ' +
  'get_chapter_text so your "anchorText" is copied verbatim from the current wording. Propose ONE edit ' +
  'per turn. After a successful call, briefly tell the author the proposed edit is ready below to review, ' +
  'refine, or apply — do not repeat the full new text in your message. If the author then asks for ' +
  'changes to placement or wording, call propose_chapter_edit again with the revised edit.';

// Appended whenever the research_entity tool is available (always).
const ENTITY_RESEARCH_GUIDANCE =
  '\n\nRESEARCHING ENTITIES: The author keeps a story bible of characters, places, and things (entities), ' +
  'each with a biography, personality, aliases, location, a timeline of events, and relationships to other ' +
  'entities. When the author asks a question about a specific character/place/thing and the answer is NOT ' +
  'already in the conversation or the story passages you were given (e.g. "what is Elara\'s backstory?", ' +
  '"who is Mara related to?", "where does the Duke live?", "what happened to Tomas before the war?"), call ' +
  'research_entity with "entityName" set to the name, nickname, or alias the author used, then answer from ' +
  'what it returns. Prefer this tool over guessing. If it reports the name is ambiguous (matches more than ' +
  'one entity), ask the author which one they mean and call it again. If it reports no match, tell the ' +
  'author you have no record of that entity. Do not invent biography, timeline, or relationship details ' +
  'that the tool did not return.';


/**
 * Builds a RAG-grounded system prompt for a chat turn. Embeds the last user
 * message, retrieves the most relevant story passages within `scope` (omit
 * `seriesId` to search every chapter the user owns), and appends numbered,
 * citable excerpts. Returns the base prompt unchanged when nothing is retrieved.
 */
async function buildRagSystemPrompt(
  messages: { role: 'user' | 'assistant'; content: string }[],
  scope: { seriesId?: string; bookId?: string; chapterId?: string },
  req: Request,
): Promise<{ systemPrompt: string; citations: ChapterCitation[] }> {
  let systemPrompt = BASE_SYSTEM_PROMPT;
  let citations: ChapterCitation[] = [];

  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  const retrievalQuery = (lastUserMessage?.content ?? '').trim();
  if (!retrievalQuery) return { systemPrompt, citations };

  const chunks = await searchChapterChunks(retrievalQuery, { ...scope, topK: 8 }, req);
  if (chunks.length === 0) return { systemPrompt, citations };

  // Number the distinct source chapters and resolve their titles so the
  // model can cite them inline and the client can render links.
  const distinctChapterIds: string[] = [];
  for (const c of chunks) {
    if (!distinctChapterIds.includes(c.chapterId)) distinctChapterIds.push(c.chapterId);
  }
  const chaptersContainer = getContainer('chapters');
  const titleById = new Map<string, string>();
  await Promise.all(
    distinctChapterIds.map(async cid => {
      try {
        const { resource } = await chaptersContainer.item(cid, cid).read<Chapter>();
        if (resource?.title) titleById.set(cid, resource.title);
      } catch {
        // Leave untitled if the chapter can't be read.
      }
    })
  );
  const numberById = new Map<string, number>();
  distinctChapterIds.forEach((cid, i) => numberById.set(cid, i + 1));
  citations = distinctChapterIds.map(cid => ({
    n: numberById.get(cid)!,
    chapterId: cid,
    title: titleById.get(cid) ?? 'Untitled chapter',
  }));

  const labeledExcerpts = chunks
    .map(c => `[${numberById.get(c.chapterId)}] (from "${titleById.get(c.chapterId) ?? 'Untitled chapter'}")\n${c.content}`)
    .join('\n\n---\n\n');
  systemPrompt +=
    `\n\nThe following are the most relevant excerpts from the author's story, ` +
    `each prefixed with a numbered source tag. Use them to ground your answer.\n\n` +
    `CITATION RULES (follow exactly):\n` +
    `- When a sentence uses information from a source, append that source's citation at the END of the ` +
    `sentence as a bracketed number, written EXACTLY like [1] or [2].\n` +
    `- For multiple sources on one sentence, write them together like [1][2].\n` +
    `- ALWAYS use this exact bracketed-number format. NEVER cite by chapter name, and never use ` +
    `parentheses, footnotes, or superscripts.\n` +
    `- Only cite numbers that appear in the list below.\n` +
    `- If the excerpts don't contain the answer, do NOT invent details and do NOT immediately give up. ` +
    `First consider whether one of your tools could find it — in particular, if the question is about a ` +
    `specific character, place, or thing, call research_entity to look up its story-bible record before ` +
    `telling the author you don't have the information.\n\n` +
    `${labeledExcerpts}`;

  return { systemPrompt, citations };
}

/** Writes the `{sources}` SSE event for the citations the answer actually used. */
function emitUsedCitations(res: Response, answer: string, citations: ChapterCitation[]): void {
  if (citations.length === 0) return;
  const citedNumbers = new Set<number>();
  for (const match of answer.matchAll(/\[([\d,\s]+)\]/g)) {
    for (const num of match[1].split(/[,\s]+/).filter(Boolean)) citedNumbers.add(Number(num));
  }
  const usedCitations = citations.filter(c => citedNumbers.has(c.n));
  if (usedCitations.length > 0) {
    res.write(`data: ${JSON.stringify({ sources: usedCitations })}\n\n`);
  }
}

/**
 * Streams a chat completion as SSE: `{content}` deltas, then a `{sources}`
 * event for any cited chapters, then `[DONE]`. Assumes SSE headers are flushed.
 *
 * When `tools` are supplied, runs a small agent loop: if the model calls a
 * tool, its result is fed back and the model is re-invoked until it produces a
 * final text answer. Tools may also stream side-effect events to the client
 * (e.g. a navigation instruction). Without tools this is a plain streamed turn.
 */
async function streamChatResponse(
  res: Response,
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  citations: ChapterCitation[],
  tools?: Record<string, ChatTool>,
  model: string = config.foundry.miniModel,
): Promise<void> {
  // The running conversation; grows as tool calls/results are appended.
  const convo: unknown[] = [{ role: 'system', content: systemPrompt }, ...messages];
  const toolDefinitions = tools ? Object.values(tools).map(t => t.definition) : undefined;
  // Lottie URL to emit after the model's final text response (set when a tool with successLottie succeeds).
  let pendingLottie: string | null = null;

  try {
    // Bounded loop: model turn → optional tool calls → model turn → … → answer.
    for (let turn = 0; turn < 4; turn++) {
      const stream = await client.chat.completions.create({
        model,
        messages: convo as never,
        ...(toolDefinitions ? { tools: toolDefinitions as never } : {}),
        stream: true,
      });

      let answer = '';
      const toolCalls: { id: string; name: string; args: string }[] = [];
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          answer += delta.content;
          res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const slot = (toolCalls[idx] ??= { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }

      const calls = toolCalls.filter(Boolean);
      if (calls.length === 0 || !tools) {
        if (pendingLottie) res.write(`data: ${JSON.stringify({ lottie: pendingLottie })}\n\n`);
        emitUsedCitations(res, answer, citations);
        res.write('data: [DONE]\n\n');
        return;
      }

      // Record the assistant turn that requested the tools, then run each tool.
      convo.push({
        role: 'assistant',
        content: answer || null,
        tool_calls: calls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        })),
      });
      for (const c of calls) {
        const tool = tools[c.name];
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = c.args ? JSON.parse(c.args) : {};
        } catch {
          // Leave args empty if the model produced invalid JSON.
        }
        // Long-running tools announce themselves before executing so the UI can
        // show progress (e.g. a "generating image" spinner).
        if (tool?.pending) res.write(`data: ${JSON.stringify(tool.pending)}\n\n`);
        const { toolResult, sse, success } = tool
          ? await tool.execute(parsedArgs)
          : { toolResult: { error: `Unknown tool ${c.name}` }, sse: undefined, success: false };
        if (sse) res.write(`data: ${JSON.stringify(sse)}\n\n`);
        if (success && tool?.successLottie) pendingLottie = tool.successLottie;
        convo.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(toolResult) });
      }
    }
    // Exhausted the loop without a final text answer; close cleanly.
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('Chat session streaming error:', err);
    const isContentFilter = (err as { code?: string })?.code === 'content_filter';
    const errorMessage = isContentFilter
      ? 'Your request was blocked by the content filter. Try rephrasing.'
      : 'AI error occurred';
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  } finally {
    res.end();
  }
}

type TitledRecord = { id: string; title?: string };
type NavTarget = 'chapter' | 'book' | 'series' | 'entity';
type TitleMatch = { id: string; title: string; score: number };

/** Scores the best title match (score ≥ 0.5) from a set of titled records. */
function bestTitleMatch(resources: TitledRecord[], title: string): TitleMatch | null {
  const query = title.trim().toLowerCase();
  if (!query) return null;
  const tokens = (s: string) => new Set(s.split(/\W+/).filter(Boolean));
  const queryTokens = tokens(query);
  let best: TitleMatch | null = null;
  for (const r of resources) {
    const t = (r.title ?? '').trim().toLowerCase();
    if (!t) continue;
    let score: number;
    if (t === query) score = 1;
    else if (t.includes(query) || query.includes(t)) score = 0.85;
    else {
      const tt = tokens(t);
      let inter = 0;
      for (const x of queryTokens) if (tt.has(x)) inter++;
      score = tt.size && queryTokens.size ? inter / Math.max(tt.size, queryTokens.size) : 0;
    }
    if (score > (best?.score ?? 0)) best = { id: r.id, title: r.title ?? '', score };
  }
  return best && best.score >= 0.5 ? best : null;
}

const NOT_HIDDEN = '(NOT IS_DEFINED(c.archived) OR c.archived = false) AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)';

/** Finds the best title match for a given resource kind among the user's items. */
async function resolveByTitle(target: NavTarget, title: string, req: Request): Promise<TitleMatch | null> {
  if (target === 'series') {
    // Series may be owned or shared, so match the series route's access rule.
    const email = req.user!.email;
    const { resources } = await getContainer('series').items
      .query<TitledRecord>({
        query: `SELECT c.id, c.title FROM c WHERE (c.owner = @owner OR ARRAY_CONTAINS(c.collaborators, @email)) AND ${NOT_HIDDEN}`,
        parameters: [{ name: '@owner', value: email }, { name: '@email', value: email }],
      })
      .fetchAll();
    return bestTitleMatch(resources, title);
  }
  const container = target === 'book' ? 'books' : 'chapters';
  const { resources } = await getContainer(container).items
    .query<TitledRecord>(withOwnerFilter(req, `SELECT c.id, c.title FROM c WHERE ${NOT_HIDDEN}`))
    .fetchAll();
  return bestTitleMatch(resources, title);
}

type EntityNameRecord = { id: string; name?: string; title?: string; firstName?: string; lastName?: string; nickname?: string; aliases?: string[] };

/** A concrete string to search the chapter for, plus the reference type to stamp
 *  on the wrapping span. Mirrors the editor's own variant/refType resolution so
 *  the client never has to re-derive forms from its (possibly incomplete) copy
 *  of the entity. */
type EntitySearchTerm = { text: string; refType: string };

/** Builds every name form (and alias) the entity can be referred to by, each
 *  paired with its reference type. Aliases have no dedicated form, so 'other'. */
function buildEntitySearchTerms(e: EntityNameRecord): EntitySearchTerm[] {
  const name = (e.name ?? '').trim();
  const title = (e.title ?? '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const first = (e.firstName ?? '').trim() || (parts.length >= 2 ? parts[0]! : '');
  const last = (e.lastName ?? '').trim() || (parts.length >= 2 ? parts[parts.length - 1]! : '');
  const nick = (e.nickname ?? '').trim();
  const out: EntitySearchTerm[] = [];
  const seen = new Set<string>();
  const add = (text: string, refType: string) => {
    const t = text.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push({ text: t, refType });
  };
  if (title && name) add(`${title} ${name}`, 'title-full-name');
  if (title && last) add(`${title} ${last}`, 'title-last-name');
  if (name) add(name, 'full-name');
  if (first && last) add(`${first} ${last}`, 'full-name');
  add(nick, 'nickname');
  add(first, 'first-name');
  add(last, 'last-name');
  // Aliases are full reference phrases (e.g. "Mark Amherst"), but the prose often
  // uses just one part of them ("Mark"). Offer the whole alias AND its first/last
  // word, mirroring how the primary name is decomposed. Skip articles and
  // one-character tokens so we don't search for "the"/"of"/etc.
  for (const a of e.aliases ?? []) {
    const alias = (a ?? '').trim();
    if (!alias) continue;
    add(alias, 'other');
    const parts = alias.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      for (const part of [parts[0]!, parts[parts.length - 1]!]) {
        if (part.length >= 2 && !ALIAS_STOPWORDS.has(part.toLowerCase())) add(part, 'other');
      }
    }
  }
  return out;
}

/** Tokens skipped when decomposing a multi-word alias into searchable parts. */
const ALIAS_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'at', 'de', 'la', 'le', 'el', 'von', 'van']);

/** True when a name form and a user-named term refer to the same thing, by
 *  whole-word containment in either direction (so "John Markson" matches the
 *  alias form, and "Mark" matches "Mark Johnson"). */
function termMatchesUserPhrase(formText: string, userTerm: string): boolean {
  const f = formText.trim().toLowerCase();
  const u = userTerm.trim().toLowerCase();
  if (!f || !u) return false;
  if (f === u) return true;
  const wb = (hay: string, needle: string) => new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay);
  return wb(f, u) || wb(u, f);
}

/** The best human-readable label for an entity, preferring its explicit name. */
function entityDisplayName(e: EntityNameRecord): string {
  return (e.name?.trim() || [e.firstName, e.lastName].filter(Boolean).join(' ').trim() || e.nickname?.trim() || '');
}

/**
 * Finds the best entity (person/place/thing) match for a name, scoring against
 * every name form the user might say (full name, first/last, nickname).
 */
async function resolveEntityByName(name: string, req: Request): Promise<TitleMatch | null> {
  const { resources } = await getContainer('entities').items
    .query<EntityNameRecord>(withOwnerFilter(req, `SELECT c.id, c.name, c.firstName, c.lastName, c.nickname, c.aliases FROM c WHERE ${NOT_HIDDEN}`))
    .fetchAll();
  let best: TitleMatch | null = null;
  for (const e of resources) {
    const aliases = [e.name, e.firstName, e.lastName, e.nickname, [e.firstName, e.lastName].filter(Boolean).join(' '), ...(e.aliases ?? [])]
      .map(a => (a ?? '').trim())
      .filter(Boolean);
    // Reuse the title scorer by treating each alias as a candidate title.
    const match = bestTitleMatch(aliases.map(a => ({ id: e.id, title: a })), name);
    if (match && match.score > (best?.score ?? 0)) {
      best = { id: e.id, title: entityDisplayName(e) || match.title, score: match.score };
    }
  }
  return best;
}

/**
 * Scores how well a queried name matches an entity's name forms, using strict
 * whole-word matching so "Mark" matches the entity "Mark Johnson" (or an alias
 * "Mark") but NOT an unrelated alias that merely contains those letters (e.g.
 * "Markon"). Returns 1 for an exact form, 0.9 when the query is a whole word
 * within a form, and 0 otherwise. Loose substring scoring is deliberately
 * avoided here — wrapping the wrong character's mentions is worse than a miss.
 */
function entityNameMatchScore(forms: string[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const wholeWord = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  let best = 0;
  for (const form of forms) {
    const f = form.trim().toLowerCase();
    if (!f) continue;
    if (f === q) return 1;
    if (wholeWord.test(f)) best = Math.max(best, 0.9);
  }
  return best;
}

/**
 * Resolves an entity name/alias to candidate matches, ranked by score. Unlike
 * resolveEntityByName this returns every strong candidate so the caller can
 * detect ambiguity (e.g. a name/alias shared by more than one entity) and ask
 * the user which one they mean.
 */
async function resolveEntityCandidates(name: string, req: Request): Promise<{ id: string; name: string; score: number; record: EntityNameRecord }[]> {
  const { resources } = await getContainer('entities').items
    .query<EntityNameRecord>(withOwnerFilter(req, `SELECT c.id, c.name, c.title, c.firstName, c.lastName, c.nickname, c.aliases FROM c WHERE ${NOT_HIDDEN}`))
    .fetchAll();
  const scored: { id: string; name: string; score: number; record: EntityNameRecord }[] = [];
  for (const e of resources) {
    const forms = [e.name, e.firstName, e.lastName, e.nickname, [e.firstName, e.lastName].filter(Boolean).join(' '), ...(e.aliases ?? [])]
      .map(a => (a ?? '').trim())
      .filter(Boolean);
    const score = entityNameMatchScore(forms, name);
    if (score > 0) scored.push({ id: e.id, name: entityDisplayName(e), score, record: e });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** Lists the user's (non-hidden) books as {id, title}. */
async function listBooks(req: Request): Promise<{ id: string; title: string }[]> {
  const { resources } = await getContainer('books').items
    .query<TitledRecord>(withOwnerFilter(req, `SELECT c.id, c.title FROM c WHERE ${NOT_HIDDEN}`))
    .fetchAll();
  return resources.map(r => ({ id: r.id, title: r.title ?? '' })).filter(b => b.title);
}

/** Lists the user's (non-hidden) chapters as {id, title}. */
async function listChapters(req: Request): Promise<{ id: string; title: string }[]> {
  const { resources } = await getContainer('chapters').items
    .query<TitledRecord>(withOwnerFilter(req, `SELECT c.id, c.title FROM c WHERE ${NOT_HIDDEN}`))
    .fetchAll();
  return resources.map(r => ({ id: r.id, title: r.title ?? '' })).filter(c => c.title);
}

// Maps are filtered on `archived` only, mirroring the maps route's access rule.
const MAP_NOT_HIDDEN = '(NOT IS_DEFINED(c.archived) OR c.archived = false)';
type MapRecord = { id: string; title?: string; thumbnailUrl?: string };

/** Finds the user's best-matching map by title, with its thumbnail if any. */
async function resolveMapByTitle(title: string, req: Request): Promise<(TitleMatch & { thumbnailUrl?: string }) | null> {
  const { resources } = await getContainer('maps').items
    .query<MapRecord>(withOwnerFilter(req, `SELECT c.id, c.title, c.thumbnailUrl FROM c WHERE ${MAP_NOT_HIDDEN}`))
    .fetchAll();
  const match = bestTitleMatch(resources, title);
  if (!match) return null;
  return { ...match, thumbnailUrl: resources.find(m => m.id === match.id)?.thumbnailUrl };
}

/** Lists the user's (non-archived) maps as {id, title}. */
async function listMaps(req: Request): Promise<{ id: string; title: string }[]> {
  const { resources } = await getContainer('maps').items
    .query<MapRecord>(withOwnerFilter(req, `SELECT c.id, c.title FROM c WHERE ${MAP_NOT_HIDDEN}`))
    .fetchAll();
  return resources.map(r => ({ id: r.id, title: r.title ?? '' })).filter(m => m.title);
}

type ChapterEntityRecord = Pick<Entity, 'id' | 'name' | 'firstName' | 'lastName' | 'nickname' | 'personality' | 'isNarrator'>;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Converts plain generated text (paragraphs separated by double newlines) into
 * chapter HTML. Each paragraph becomes a <p> wrapping a data-ai-generated span.
 * Entity names are annotated inline with entity-reference spans.
 */
function buildAnnotatedChapterHtml(plainText: string, entities: ChapterEntityRecord[]): string {
  type NameEntry = { name: string; entityId: string; refType: string };
  const entries: NameEntry[] = [];
  for (const entity of entities) {
    const fullName = entity.name?.trim();
    const firstName = entity.firstName?.trim();
    const lastName = entity.lastName?.trim();
    const nickname = entity.nickname?.trim();
    if (fullName) entries.push({ name: fullName, entityId: entity.id, refType: 'full-name' });
    if (firstName && firstName !== fullName) entries.push({ name: firstName, entityId: entity.id, refType: 'first-name' });
    if (lastName && lastName !== fullName) entries.push({ name: lastName, entityId: entity.id, refType: 'last-name' });
    if (nickname && nickname !== fullName) entries.push({ name: nickname, entityId: entity.id, refType: 'nickname' });
  }
  entries.sort((a, b) => b.name.length - a.name.length);

  const annotate = (text: string): string => {
    if (entries.length === 0) return escapeHtml(text);
    const escapedNames = entries.map(e => e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`\\b(${escapedNames.join('|')})\\b`, 'g');
    let out = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) out += escapeHtml(text.slice(lastIndex, match.index));
      const entry = entries.find(e => e.name === match![0]);
      if (entry) {
        out += `<span data-id="${escapeHtml(entry.entityId)}" data-reference-type="${entry.refType}" class="entity-reference">${escapeHtml(match![0])}</span>`;
      } else {
        out += escapeHtml(match![0]);
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) out += escapeHtml(text.slice(lastIndex));
    return out;
  };

  return plainText
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p><span data-ai-generated="true">${annotate(p)}</span></p>`)
    .join('');
}

/**
 * Generates HTML content for a new chapter using the AI, grounded in the
 * book's narrator voice and entity list. Returns empty string on failure.
 */
async function generateChapterContent(bookId: string, title: string, description: string, req: Request): Promise<string> {
  let seriesId: string | undefined;
  try {
    const { resource: book } = await getContainer('books').item(bookId, bookId).read<Book>();
    seriesId = book?.seriesId;
  } catch {
    // proceed without series context
  }

  let entities: ChapterEntityRecord[] = [];
  if (seriesId) {
    const { resources } = await getContainer('entities').items
      .query<ChapterEntityRecord>(withOwnerFilter(req, {
        query:
          'SELECT c.id, c.name, c.firstName, c.lastName, c.nickname, c.personality, c.isNarrator ' +
          'FROM c WHERE c.seriesId = @seriesId ' +
          'AND (NOT IS_DEFINED(c.archived) OR c.archived = false) ' +
          'AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)',
        parameters: [{ name: '@seriesId', value: seriesId }],
      }))
      .fetchAll();
    entities = resources;
  }

  const narrator = entities.find(e => e.isNarrator);
  const nonNarrators = entities.filter(e => !e.isNarrator);
  const entityNames = nonNarrators
    .map(e => e.name?.trim() || [e.firstName, e.lastName].filter(Boolean).join(' ').trim() || '')
    .filter(Boolean);

  let systemPrompt =
    'You are a creative writing assistant helping an author write chapter content. Write in flowing narrative prose with vivid details.';
  if (narrator?.personality) {
    systemPrompt +=
      '\n\nThe story uses a specific narrative voice. Use the following narrator profile to guide the prose style and tone:\n\n' +
      narrator.personality;
  }
  if (entityNames.length > 0) {
    systemPrompt +=
      '\n\nKnown characters and places in this story (use these exact names when referencing them): ' +
      entityNames.join(', ') + '.';
  }
  systemPrompt +=
    '\n\nReturn ONLY the chapter text as plain paragraphs separated by double newlines. ' +
    'Do not include HTML, markdown, or a chapter title heading — write only narrative content.';

  try {
    const response = await client.chat.completions.create({
      model: config.foundry.fullModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Write the content for a chapter titled "${title}" based on the following description:\n\n${description}` },
      ],
      stream: false,
    });
    const generatedText = response.choices[0]?.message?.content?.trim() ?? '';
    if (!generatedText) return '';
    return buildAnnotatedChapterHtml(generatedText, entities);
  } catch (err) {
    console.error('Error generating chapter content:', err);
    return '';
  }
}

/** Creates a chapter at the end of the given book and indexes it for search. */
async function createChapterInBook(bookId: string, title: string, req: Request, description?: string): Promise<{ id: string; title: string }> {
  const chaptersContainer = getContainer('chapters');
  // New chapters go at the end of the book: next sortOrder after the current max.
  const { resources } = await chaptersContainer.items
    .query<{ sortOrder?: number }>(
      withOwnerFilter(req, {
        query: 'SELECT c.sortOrder FROM c WHERE c.bookId = @bookId',
        parameters: [{ name: '@bookId', value: bookId }],
      }),
    )
    .fetchAll();
  const sortOrder = resources.reduce((max, c) => Math.max(max, (c.sortOrder ?? 0) + 1), 0);

  const now = new Date().toISOString();
  const email = req.user!.email;
  const content = description ? await generateChapterContent(bookId, title, description, req) : '';
  const chapter: Chapter = {
    id: randomUUID(),
    title,
    bookId,
    content,
    sortOrder,
    owner: email,
    createdBy: email,
    createdAt: now,
    modifiedBy: email,
    modifiedAt: now,
  };
  const { resource } = await chaptersContainer.items.create<Chapter>(chapter);
  if (resource) await reindexChapterChunks(resource);
  return { id: chapter.id, title };
}

/** Strips HTML tags and collapses whitespace to plain text. */
function stripHtmlToPlain(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Tool that lets the LLM fetch the full text of the chapter being edited.
 * Only injected when the chat is anchored to a specific chapter (chapter-edit context).
 */
function getChapterTextTool(chapterId: string, req: Request): ChatTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_chapter_text',
        description:
          'Retrieve the full plain text of the chapter currently being edited. Call this when you need ' +
          'the complete chapter content to write dialog that fits the existing voice, suggest plot points ' +
          'that naturally follow what has been written, analyze narrative arc, identify character moments, ' +
          'or give any other context-aware writing assistance that requires reading the whole chapter. ' +
          'Returns the chapter text as plain prose with word count.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    },
    execute: async () => {
      try {
        const { resource } = await getContainer('chapters').item(chapterId, chapterId).read<Chapter>();
        if (!resource || resource.owner !== req.user!.email) {
          console.log('[get_chapter_text] access denied for chapterId=%s', chapterId);
          return { toolResult: { error: 'Chapter not found or access denied.' } };
        }
        const text = stripHtmlToPlain(resource.content ?? '');
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        console.log('[get_chapter_text] invoked — chapter="%s" wordCount=%d', resource.title, wordCount);
        return { toolResult: { title: resource.title, text, wordCount } };
      } catch {
        console.log('[get_chapter_text] error reading chapterId=%s', chapterId);
        return { toolResult: { error: 'Failed to retrieve chapter text.' } };
      }
    },
  };
}

/**
 * Tool that finds plain-text mentions of an entity in the chapter being edited
 * and offers to wrap them in entity-reference markup. The heavy lifting (scanning
 * the live editor content, prompting the author one match at a time, and wrapping
 * the spans) happens client-side; this tool only resolves which entity the author
 * meant — handling alias lookup and ambiguity — and hands the id to the client.
 */
function getLinkEntityReferencesTool(req: Request): ChatTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'link_entity_references',
        description:
          'Find plain-text mentions of a character, place, or thing in the chapter the author is ' +
          'editing and wrap them in entity-reference markup. Use when the author asks to link, tag, ' +
          'mark, or connect references/mentions of an entity. "entityName" is the name or alias the ' +
          'author used (alias lookup is handled for you). Pass "terms" ONLY when the author limits it ' +
          'to specific word(s)/phrase(s); omit it to offer every name form and alias. The author ' +
          'confirms each match in the editor, so do not ask which mentions to change here.',
        parameters: {
          type: 'object',
          properties: {
            entityName: {
              type: 'string',
              description: 'The entity name or alias the author referred to (e.g. "Mark Johnson", "John Markson").',
            },
            terms: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional specific phrase(s) to search for, only when the author restricts the search to them.',
            },
          },
          required: ['entityName'],
        },
      },
    },
    pending: { linkingReferences: true },
    execute: async args => {
      const entityName = String(args['entityName'] ?? '').trim();
      const terms = Array.isArray(args['terms'])
        ? (args['terms'] as unknown[]).map(t => String(t).trim()).filter(Boolean)
        : undefined;
      if (!entityName) {
        return { toolResult: { found: false, message: 'No entity name was given. Ask the author which entity to link.' } };
      }
      const candidates = await resolveEntityCandidates(entityName, req);
      // Require a strong (exact or whole-word) match — a loose partial match risks
      // wrapping a different character's mentions, which is worse than a miss.
      const strong = candidates.filter(c => c.score >= 0.9);
      if (strong.length === 0) {
        return {
          toolResult: {
            found: false,
            message: `No entity matching "${entityName}" was found. Ask the author for the correct name.`,
          },
        };
      }
      // Treat equally-strong matches (same score) as ambiguous so the author picks.
      const top = strong[0]!;
      const contenders = strong.filter(c => c.score >= top.score - 0.001);
      if (contenders.length > 1) {
        return {
          toolResult: {
            found: false,
            ambiguous: true,
            candidates: contenders.map(c => c.name),
            message: `"${entityName}" could refer to more than one entity. Ask the author which one they mean: ${contenders.map(c => c.name).join(', ')}.`,
          },
        };
      }
      // Build the concrete strings to search for from the resolved entity's own
      // record (so aliases are always included). When the author restricted the
      // search to specific phrases, keep only the matching forms.
      const allTerms = buildEntitySearchTerms(top.record);
      let searchTerms = allTerms;
      if (terms && terms.length) {
        const filtered = allTerms.filter(t => terms.some(u => termMatchesUserPhrase(t.text, u)));
        if (filtered.length) searchTerms = filtered;
      }
      if (searchTerms.length === 0) {
        return {
          toolResult: { found: false, message: `Could not determine what text to search for ${top.name}.` },
        };
      }
      return {
        toolResult: { found: true, entityName: top.name, message: `Scanning the chapter for plain-text references to ${top.name}.` },
        sse: { linkEntityReferences: { entityId: top.id, entityName: top.name, terms: searchTerms } },
      };
    },
  };
}

/** Collapses all whitespace to single spaces and trims, for anchor matching. */
function normalizeForAnchor(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Tool that proposes a single targeted edit (insert/replace/delete) to the
 * chapter being edited, anchored to a verbatim snippet of the current text.
 * The server only validates that the anchor locates the edit unambiguously and
 * hands the proposal to the client; the author reviews a before→after card in
 * the chat, can refine it over multiple turns, and applies it into the live
 * editor when satisfied (mirroring the entity-linking hand-off pattern).
 */
function getProposeChapterEditTool(chapterId: string, req: Request): ChatTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'propose_chapter_edit',
        description:
          'Propose a single, specific edit to the chapter the author is editing — adding, changing, or ' +
          'removing content — for the author to review and confirm. Use this whenever the author asks to ' +
          'add/insert, change/rewrite/reword, or remove/delete some content and describes what they want. ' +
          'First call get_chapter_text so you know the exact current wording. "anchorText" MUST be copied ' +
          'VERBATIM from the current chapter (exact characters, within a single paragraph) and must be long ' +
          'enough to occur exactly once — include a few surrounding words if a short phrase is ambiguous. ' +
          'For "insert", anchorText is the existing sentence/phrase you insert next to (set "position" to ' +
          'before/after) and "newText" is the content to add. For "replace", anchorText is the exact text ' +
          'to swap out and "newText" is its replacement. For "delete", anchorText is the exact text to ' +
          'remove ("newText" omitted). Keep "explanation" to one short sentence describing the change. If ' +
          'the tool reports the anchor was not found or is ambiguous, fix anchorText and call again.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['insert', 'replace', 'delete'], description: 'The kind of edit.' },
            anchorText: {
              type: 'string',
              description: 'Verbatim snippet from the current chapter that locates the edit (single paragraph, unique).',
            },
            position: {
              type: 'string',
              enum: ['before', 'after'],
              description: 'For "insert" only: insert the new text before or after the anchor. Defaults to after.',
            },
            newText: {
              type: 'string',
              description: 'The content to add (insert) or the replacement text (replace). Omit for delete.',
            },
            explanation: {
              type: 'string',
              description: 'One short sentence describing the change, shown to the author.',
            },
          },
          required: ['kind', 'anchorText', 'explanation'],
        },
      },
    },
    execute: async args => {
      const kind = String(args['kind'] ?? '').trim();
      const anchorText = String(args['anchorText'] ?? '');
      const position = args['position'] === 'before' ? 'before' : 'after';
      const newText = args['newText'] != null ? String(args['newText']) : '';
      const explanation = String(args['explanation'] ?? '').trim();

      if (kind !== 'insert' && kind !== 'replace' && kind !== 'delete') {
        return { toolResult: { ok: false, message: 'kind must be one of insert, replace, or delete.' } };
      }
      if (!normalizeForAnchor(anchorText)) {
        return { toolResult: { ok: false, message: 'anchorText is required and must be copied from the chapter.' } };
      }
      if ((kind === 'insert' || kind === 'replace') && !newText.trim()) {
        return { toolResult: { ok: false, message: `newText is required for a ${kind} edit.` } };
      }

      // Validate the anchor against the saved chapter text. The live editor is the
      // authority at apply time, but this catches hallucinated/ambiguous anchors now.
      let plain: string;
      try {
        const { resource } = await getContainer('chapters').item(chapterId, chapterId).read<Chapter>();
        if (!resource || resource.owner !== req.user!.email) {
          return { toolResult: { ok: false, message: 'Chapter not found or access denied.' } };
        }
        plain = normalizeForAnchor(stripHtmlToPlain(resource.content ?? ''));
      } catch {
        return { toolResult: { ok: false, message: 'Failed to read the chapter to validate the edit.' } };
      }

      const needle = normalizeForAnchor(anchorText);
      let count = 0;
      for (let i = plain.indexOf(needle); i !== -1; i = plain.indexOf(needle, i + 1)) count++;
      if (count === 0) {
        return {
          toolResult: {
            ok: false,
            message:
              'anchorText was not found in the chapter. Copy it verbatim from get_chapter_text (exact wording) and try again.',
          },
        };
      }
      if (count > 1) {
        return {
          toolResult: {
            ok: false,
            message: `anchorText matches ${count} places in the chapter. Make it longer / more specific so it occurs exactly once.`,
          },
        };
      }

      const proposal = {
        kind,
        anchorText,
        ...(kind === 'insert' ? { position } : {}),
        ...(kind === 'delete' ? {} : { newText }),
        explanation: explanation || 'Proposed edit',
      };
      return {
        toolResult: {
          ok: true,
          message: 'Proposed the edit. Tell the author it is ready below to review, refine, or apply.',
        },
        sse: { proposeChapterEdit: proposal },
      };
    },
  };
}

/** A compact, LLM-readable timeline event (only the fields worth reasoning over). */
type ResearchTimelineEvent = { name: string; timeframe?: string; description?: string; location?: string };
/** A compact, LLM-readable relationship: who, how, and any note. */
type ResearchRelationship = { partner: string; type: string; description?: string };

/**
 * Assembles the full story-bible record for one entity — its profile fields, its
 * timeline of events (ordered along the timeline), and its relationships (either
 * direction, enriched with the partner's name) — shaped for the LLM to answer
 * questions from. Returns null when the entity is missing, deleted, or not owned
 * by the requester. Mirrors the queries the entity/timeline/relationship routes use.
 */
async function buildEntityResearch(entityId: string, req: Request): Promise<Record<string, unknown> | null> {
  const { resource: entity } = await getContainer('entities').item(entityId, entityId).read<Entity>();
  if (!entity || entity.owner !== req.user!.email || entity.deleted) return null;

  // Timeline events live in their own container, partitioned by entityId.
  const { resources: rawEvents } = await getContainer('timeline-events').items
    .query<TimelineEvent>(
      withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.entityId = @entityId',
        parameters: [{ name: '@entityId', value: entityId }],
      }),
      { partitionKey: entityId },
    )
    .fetchAll();
  const timelineEvents: ResearchTimelineEvent[] = rawEvents
    .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
    .map(e => ({ name: e.name, timeframe: e.timeframe || undefined, description: e.description || undefined, location: e.location || undefined }));

  // Relationships reference partners only by id, so resolve their names.
  const { resources: rels } = await getContainer('entity-relationships').items
    .query<EntityRelationship>(
      withOwnerFilter(req, {
        query: 'SELECT * FROM c WHERE c.sourceEntityId = @id OR c.targetEntityId = @id',
        parameters: [{ name: '@id', value: entityId }],
      }),
    )
    .fetchAll();
  let relationships: ResearchRelationship[] = [];
  if (rels.length) {
    const partnerIds = [...new Set(rels.map(r => (r.sourceEntityId === entityId ? r.targetEntityId : r.sourceEntityId)))];
    const params = partnerIds.map((id, i) => ({ name: `@p${i}`, value: id }));
    const inClause = params.map(p => p.name).join(', ');
    const { resources: partners } = await getContainer('entities').items
      .query<Pick<Entity, 'id' | 'name' | 'deleted' | 'archived'>>(
        withOwnerFilter(req, {
          query: `SELECT c.id, c.name, c.deleted, c.archived FROM c WHERE c.id IN (${inClause})`,
          parameters: params,
        }),
      )
      .fetchAll();
    const nameById = new Map(partners.filter(p => !p.deleted && !p.archived).map(p => [p.id, p.name]));
    relationships = rels.flatMap(r => {
      const partner = nameById.get(r.sourceEntityId === entityId ? r.targetEntityId : r.sourceEntityId);
      return partner ? [{ partner, type: r.relationshipType, description: r.description || undefined }] : [];
    });
  }

  const loc = entity.location;
  const location =
    loc?.type === 'real-world'
      ? loc.realWorld?.address || (loc.realWorld ? `${loc.realWorld.lat}, ${loc.realWorld.lng}` : undefined)
      : loc?.type === 'fictional'
        ? 'Placed on a fictional map'
        : undefined;

  // Drop empty fields so the model isn't fed a wall of nulls.
  const record: Record<string, unknown> = {
    name: entity.name,
    type: entity.type,
    title: entity.title || undefined,
    nickname: entity.nickname || undefined,
    aliases: entity.aliases?.length ? entity.aliases : undefined,
    isNarrator: entity.isNarrator || undefined,
    gender: entity.gender || undefined,
    race: entity.race || undefined,
    biography: entity.biography || undefined,
    personality: entity.personality || undefined,
    location,
    timelineEvents: timelineEvents.length ? timelineEvents : undefined,
    relationships: relationships.length ? relationships : undefined,
  };
  for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
  return record;
}

/**
 * Tool that looks up an entity's full story-bible record (profile, timeline,
 * relationships) so the model can answer questions the story passages don't
 * cover. Resolves the name/alias to a single entity, surfacing ambiguity or a
 * miss back to the model rather than guessing. Available in every chat context.
 */
function getResearchEntityTool(req: Request): ChatTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'research_entity',
        description:
          'Look up the author\'s full story-bible record for a character, place, or thing (entity): its ' +
          'biography, personality, aliases, location, timeline of events, and relationships to other entities. ' +
          'Call this when the author asks a question about a specific character/place/thing that the ' +
          'conversation and the story passages already provided cannot answer (e.g. backstory, who someone ' +
          'is related to, where they live, what happened to them and when). "entityName" is the name, ' +
          'nickname, or alias the author used (alias lookup is handled for you). If the result is ambiguous, ' +
          'ask the author which entity they mean and call again; if there is no match, tell the author.',
        parameters: {
          type: 'object',
          properties: {
            entityName: {
              type: 'string',
              description: 'The name, nickname, or alias of the entity to research (e.g. "Elara", "the Duke", "Mara Quinn").',
            },
          },
          required: ['entityName'],
        },
      },
    },
    pending: { researchingEntity: true },
    execute: async args => {
      const entityName = String(args['entityName'] ?? '').trim();
      if (!entityName) {
        return { toolResult: { found: false, message: 'No entity name was given. Ask the author which entity to research.' } };
      }
      const candidates = await resolveEntityCandidates(entityName, req);
      // Require a strong (exact or whole-word) match so we don't research the wrong entity.
      const strong = candidates.filter(c => c.score >= 0.9);
      if (strong.length === 0) {
        return {
          toolResult: { found: false, message: `No entity matching "${entityName}" was found. Tell the author you have no record of that entity.` },
        };
      }
      const top = strong[0]!;
      const contenders = strong.filter(c => c.score >= top.score - 0.001);
      if (contenders.length > 1) {
        return {
          toolResult: {
            found: false,
            ambiguous: true,
            candidates: contenders.map(c => c.name),
            message: `"${entityName}" could refer to more than one entity. Ask the author which one they mean: ${contenders.map(c => c.name).join(', ')}.`,
          },
        };
      }
      const record = await buildEntityResearch(top.id, req);
      if (!record) {
        return { toolResult: { found: false, message: `Could not load the record for ${top.name}.` } };
      }
      console.log('[research_entity] invoked — entity="%s"', top.name);
      return { toolResult: { found: true, entity: record } };
    },
  };
}

/** Tools available to the quick-chat (cross-series) assistant. */
function quickChatTools(req: Request): Record<string, ChatTool> {
  return {
    research_entity: getResearchEntityTool(req),
    create_chapter: {
      definition: {
        type: 'function',
        function: {
          name: 'create_chapter',
          description:
            'Create a new chapter for the user and open it. Extract details from the user\'s phrasing: pass ' +
            '"title" when they name the chapter (e.g. "create a chapter called \'Joining the Fray\'" → title ' +
            '"Joining the Fray"), "bookName" when they say which book (e.g. "...in Lithium" → bookName ' +
            '"Lithium"), and "description" when the user describes what should happen in the chapter (e.g. ' +
            '"where Dale confronts the mayor about the missing funds" → description "Dale confronts the mayor ' +
            'about the missing funds"). When description is provided the chapter will be pre-populated with ' +
            'AI-generated content based on it. If the user did NOT indicate a book, call this WITHOUT bookName ' +
            '— the tool will return the list of books so you can ask the user which one, then call it again ' +
            'with their choice. Do not invent a title or description the user did not provide.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The chapter title, if the user provided one.' },
              bookName: { type: 'string', description: 'The book to create the chapter in, if the user indicated one.' },
              description: {
                type: 'string',
                description:
                  'What should happen in the chapter — plot points, events, characters involved — if the user described it. ' +
                  'Used to pre-populate the chapter with AI-generated content.',
              },
            },
            required: [],
          },
        },
      },
      pending: { generatingChapter: true },
      execute: async args => {
        const title = String(args['title'] ?? '').trim();
        const bookName = String(args['bookName'] ?? '').trim();
        const description = String(args['description'] ?? '').trim();

        const book = bookName ? await resolveByTitle('book', bookName, req) : null;
        if (!book) {
          const availableBooks = (await listBooks(req)).map(b => b.title);
          return {
            toolResult: {
              created: false,
              needBook: true,
              availableBooks,
              message: bookName
                ? `No book matching "${bookName}" was found. Ask the user which book to use, choosing from availableBooks.`
                : 'No book was specified. Ask the user which book to create the chapter in, choosing from availableBooks.',
            },
          };
        }

        const created = await createChapterInBook(book.id, title || 'Untitled Chapter', req, description || undefined);
        return {
          toolResult: { created: true, chapterId: created.id, title: created.title, book: book.title, hasContent: !!description },
          sse: { navigate: { target: 'chapter', id: created.id, title: created.title } },
        };
      },
    },
    navigate: {
      definition: {
        type: 'function',
        function: {
          name: 'navigate',
          description:
            'Navigate/open the user to one of their chapters, books, series, or entities when they ask to go to, ' +
            'open, take me to, jump to, or show something by name (e.g. "take me to Lithium" or "show me Dale\'s ' +
            'profile"). Books and series are containers; a chapter is a single document inside a book; an entity is ' +
            'a person, place, or thing in a series (a character, location, or object) — opening it shows its ' +
            'profile. Provide "type" only when the user is explicit about the kind (e.g. "the book Lithium", "the ' +
            'chapter Happy Birthday", or "Dale\'s profile" → entity); otherwise omit it and the best match across ' +
            'all kinds is chosen.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The name/title the user referred to.' },
              type: {
                type: 'string',
                enum: ['chapter', 'book', 'series', 'entity'],
                description: 'Optional kind, only when the user is explicit about it.',
              },
            },
            required: ['name'],
          },
        },
      },
      execute: async args => {
        const name = String(args['name'] ?? '');
        const hint = args['type'] as NavTarget | undefined;
        // When the kind is hinted, search only that; otherwise search broadest
        // (series) to narrowest (chapter) so ties resolve to the container view.
        const targets: NavTarget[] = hint ? [hint] : ['series', 'book', 'chapter', 'entity'];
        const candidates: (TitleMatch & { target: NavTarget })[] = [];
        for (const target of targets) {
          const match = target === 'entity'
            ? await resolveEntityByName(name, req)
            : await resolveByTitle(target, name, req);
          if (match) candidates.push({ ...match, target });
        }
        // Highest score wins; stable order above breaks exact-score ties.
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        if (best) {
          return {
            toolResult: { found: true, target: best.target, id: best.id, title: best.title },
            sse: { navigate: { target: best.target, id: best.id, title: best.title } },
          };
        }
        return { toolResult: { found: false, message: `Nothing matching "${name}" was found.` } };
      },
    },
    edit_chapter: {
      definition: {
        type: 'function',
        function: {
          name: 'edit_chapter',
          description:
            'Start an AI editorial pass ("Quill Editor") on one of the user\'s chapters. Use this when the user ' +
            'asks to edit, review, proofread, run the editor on, or get editorial suggestions for a chapter ' +
            '(e.g. "edit Archimedes Fire" or "run the Quill Editor on chapter 3"). This opens the chapter, ' +
            'reveals the Quill Editor panel, and automatically runs the editorial pass. Pass "name" as the ' +
            'chapter title the user referred to. If the user did NOT name a chapter, call this WITHOUT name — ' +
            'the tool returns the list of chapters so you can ask the user which one, then call it again with ' +
            'their choice.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The chapter title the user referred to, if they named one.' },
            },
            required: [],
          },
        },
      },
      execute: async args => {
        const name = String(args['name'] ?? '').trim();
        const chapter = name ? await resolveByTitle('chapter', name, req) : null;
        if (!chapter) {
          const availableChapters = (await listChapters(req)).map(c => c.title);
          return {
            toolResult: {
              started: false,
              availableChapters,
              message: name
                ? `No chapter matching "${name}" was found. Ask the user which chapter they meant, choosing from availableChapters.`
                : 'No chapter was specified. Ask the user which chapter to edit, choosing from availableChapters.',
            },
          };
        }
        return {
          toolResult: { started: true, chapterId: chapter.id, title: chapter.title },
          sse: { navigate: { target: 'chapter', id: chapter.id, title: chapter.title }, runEditor: true },
        };
      },
    },
    show_map: {
      definition: {
        type: 'function',
        function: {
          name: 'show_map',
          description:
            'Display one of the user\'s maps inline in the chat as a thumbnail they can click to open at full ' +
            'size. Use this when the user asks to see, show, display, or pull up a map by name (e.g. "show me the ' +
            'map of the Northern Kingdoms"). Pass "name" as the map title the user referred to. If no map matches, ' +
            'the tool returns the list of available maps so you can ask the user which one they meant. Prefer this ' +
            'over the navigate tool when the user wants to view a map without leaving the chat.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The map title the user referred to.' },
            },
            required: ['name'],
          },
        },
      },
      execute: async args => {
        const name = String(args['name'] ?? '').trim();
        const map = name ? await resolveMapByTitle(name, req) : null;
        if (!map) {
          const availableMaps = (await listMaps(req)).map(m => m.title);
          return {
            toolResult: {
              found: false,
              availableMaps,
              message: name
                ? `No map matching "${name}" was found. Ask the user which map they meant, choosing from availableMaps.`
                : 'No map name was given. Ask the user which map to show, choosing from availableMaps.',
            },
          };
        }
        return {
          toolResult: { found: true, mapId: map.id, title: map.title, hasThumbnail: !!map.thumbnailUrl },
          sse: { map: { id: map.id, title: map.title, thumbnailUrl: map.thumbnailUrl } },
        };
      },
    },
    add_book_note: {
      successLottie: 'https://lottie.host/883c202e-9be4-4254-9dba-3fdc86a4ac69/7iuM3NQkyu.json',
      definition: {
        type: 'function',
        function: {
          name: 'add_book_note',
          description:
            'Add a note to one of the user\'s books (book-level notes, NOT chapter notes). Use this ONLY when ' +
            'the user explicitly refers to a book title (e.g. "add a note to the book Lithium"). If the user ' +
            'mentions a chapter name, use add_chapter_note instead. Extract "bookName" from the book they ' +
            'mention and "note" from the content they want to save. If the book is not specified, call WITHOUT ' +
            'bookName to get the list of books and ask the user which one. If the note content is not specified, ' +
            'ask for it before calling.',
          parameters: {
            type: 'object',
            properties: {
              bookName: { type: 'string', description: 'The book to add the note to, if the user specified one.' },
              note: { type: 'string', description: 'The note content to add.' },
            },
            required: [],
          },
        },
      },
      execute: async args => {
        const bookName = String(args['bookName'] ?? '').trim();
        const noteContent = String(args['note'] ?? '').trim();

        if (!noteContent) {
          return {
            toolResult: {
              added: false,
              needNote: true,
              message: 'No note content was provided. Ask the user what they would like the note to say.',
            },
          };
        }

        const book = bookName ? await resolveByTitle('book', bookName, req) : null;
        if (!book) {
          const availableBooks = (await listBooks(req)).map(b => b.title);
          return {
            toolResult: {
              added: false,
              needBook: true,
              availableBooks,
              message: bookName
                ? `No book matching "${bookName}" was found. Ask the user which book to use, choosing from availableBooks.`
                : 'No book was specified. Ask the user which book to add the note to, choosing from availableBooks.',
            },
          };
        }

        const now = new Date().toISOString();
        const email = req.user!.email;
        const { resources: existing } = await getContainer('book-notes').items
          .query({ query: 'SELECT VALUE MAX(c.sortOrder) FROM c WHERE c.bookId = @bookId', parameters: [{ name: '@bookId', value: book.id }] })
          .fetchAll();
        const maxSort = typeof existing[0] === 'number' ? existing[0] : -1;

        const note: BookNote = {
          id: randomUUID(),
          bookId: book.id,
          content: noteContent,
          sortOrder: maxSort + 1,
          owner: email,
          createdBy: email,
          createdAt: now,
          modifiedBy: email,
          modifiedAt: now,
        };
        await getContainer('book-notes').items.create<BookNote>(note);

        return {
          toolResult: { added: true, book: book.title, message: `Note added to "${book.title}" successfully.` },
          success: true,
        };
      },
    },
    add_chapter_note: {
      successLottie: 'https://lottie.host/883c202e-9be4-4254-9dba-3fdc86a4ac69/7iuM3NQkyu.json',
      definition: {
        type: 'function',
        function: {
          name: 'add_chapter_note',
          description:
            'Add a note to one of the user\'s chapters. Use this when the user mentions a chapter name — ' +
            'e.g. "add a note to the chapter Archimedes Fire that says tacos are the best", or when they ' +
            'clarify that a name they gave is a chapter (not a book). Extract "chapterName" from the chapter ' +
            'they mention and "note" from the content they want to save. If the chapter is not specified, ask ' +
            'the user which chapter. If the note content is not specified, ask for it before calling.',
          parameters: {
            type: 'object',
            properties: {
              chapterName: { type: 'string', description: 'The chapter to add the note to, if specified.' },
              note: { type: 'string', description: 'The note content to add.' },
            },
            required: [],
          },
        },
      },
      execute: async args => {
        const chapterName = String(args['chapterName'] ?? '').trim();
        const noteContent = String(args['note'] ?? '').trim();

        if (!noteContent) {
          return {
            toolResult: {
              added: false,
              needNote: true,
              message: 'No note content was provided. Ask the user what they would like the note to say.',
            },
          };
        }

        const chapter = chapterName ? await resolveByTitle('chapter', chapterName, req) : null;
        if (!chapter) {
          return {
            toolResult: {
              added: false,
              needChapter: true,
              message: chapterName
                ? `No chapter matching "${chapterName}" was found. Ask the user which chapter to use.`
                : 'No chapter was specified. Ask the user which chapter to add the note to.',
            },
          };
        }

        const { resource: fullChapter } = await getContainer('chapters').item(chapter.id, chapter.id).read<Chapter>();
        if (!fullChapter) {
          return { toolResult: { added: false, message: 'Could not load the chapter.' } };
        }

        const now = new Date().toISOString();
        const email = req.user!.email;
        const newNote: ChapterNote = {
          id: randomUUID(),
          noteText: noteContent,
          selectedText: '',
          createdAt: now,
          createdBy: email,
        };
        const updated: Chapter = {
          ...fullChapter,
          notes: [...(fullChapter.notes ?? []), newNote],
          modifiedBy: email,
          modifiedAt: now,
        };
        delete (updated as { contentVector?: unknown }).contentVector;
        try {
          await getContainer('chapters').item(chapter.id, chapter.id).replace<Chapter>(updated);
        } catch (err) {
          console.error('add_chapter_note replace failed:', err);
          return { toolResult: { added: false, message: 'Failed to save the note. Please try again.' } };
        }

        return {
          toolResult: { added: true, chapter: chapter.title, message: `Note added to "${chapter.title}" successfully.` },
          sse: { chapterUpdated: { id: chapter.id, notes: updated.notes } },
          success: true,
        };
      },
    },
    add_book_outline_item: {
      successLottie: 'https://lottie.host/883c202e-9be4-4254-9dba-3fdc86a4ac69/7iuM3NQkyu.json',
      definition: {
        type: 'function',
        function: {
          name: 'add_book_outline_item',
          description:
            'Add an outline item to one of the user\'s books. Use this when the user says "add to the outline ' +
            'of <book>" or "add <item> to the <book> outline". Extract "bookName" from the book they mention, ' +
            '"item" from the text they want to add, and "level" (0 for a section heading, 1 for a sub-point — ' +
            'default 0). If the book is not specified, call WITHOUT bookName to get the list of books and ask ' +
            'the user which one. If the item text is not specified, ask for it before calling.',
          parameters: {
            type: 'object',
            properties: {
              bookName: { type: 'string', description: 'The book to add the outline item to, if specified.' },
              item: { type: 'string', description: 'The outline item text to add.' },
              level: { type: 'number', description: '0 for a section heading, 1 for a sub-point. Defaults to 0.' },
            },
            required: [],
          },
        },
      },
      execute: async args => {
        const bookName = String(args['bookName'] ?? '').trim();
        const itemText = String(args['item'] ?? '').trim();
        const level = args['level'] === 1 ? 1 : 0;

        if (!itemText) {
          return {
            toolResult: {
              added: false,
              needItem: true,
              message: 'No outline item text was provided. Ask the user what text to add to the outline.',
            },
          };
        }

        const book = bookName ? await resolveByTitle('book', bookName, req) : null;
        if (!book) {
          const availableBooks = (await listBooks(req)).map(b => b.title);
          return {
            toolResult: {
              added: false,
              needBook: true,
              availableBooks,
              message: bookName
                ? `No book matching "${bookName}" was found. Ask the user which book to use, choosing from availableBooks.`
                : 'No book was specified. Ask the user which book to add the outline item to, choosing from availableBooks.',
            },
          };
        }

        const { resource: fullBook } = await getContainer('books').item(book.id, book.id).read<Book>();
        if (!fullBook) {
          return { toolResult: { added: false, message: 'Could not load the book.' } };
        }

        const now = new Date().toISOString();
        const email = req.user!.email;
        const newItem: OutlineItem = { id: randomUUID(), text: itemText, level };
        const updated: Book = {
          ...fullBook,
          outline: [...(fullBook.outline ?? []), newItem],
          modifiedBy: email,
          modifiedAt: now,
        };
        await getContainer('books').item(book.id, book.id).replace<Book>(updated);

        return {
          toolResult: { added: true, book: book.title, item: itemText, level, message: `Outline item added to "${book.title}" successfully.` },
          success: true,
        };
      },
    },
    add_chapter_outline_item: {
      successLottie: 'https://lottie.host/883c202e-9be4-4254-9dba-3fdc86a4ac69/7iuM3NQkyu.json',
      definition: {
        type: 'function',
        function: {
          name: 'add_chapter_outline_item',
          description:
            'Add an outline item to one of the user\'s chapters. Use this when the user says "add to the outline ' +
            'of <chapter>" or "add <item> to the <chapter> outline". Extract "chapterName" from the chapter they ' +
            'mention, "item" from the text they want to add, and "level" (0 for a section heading, 1 for a ' +
            'sub-point — default 1). If the chapter is not specified, ask the user which chapter. If the item ' +
            'text is not specified, ask for it before calling.',
          parameters: {
            type: 'object',
            properties: {
              chapterName: { type: 'string', description: 'The chapter to add the outline item to, if specified.' },
              item: { type: 'string', description: 'The outline item text to add.' },
              level: { type: 'number', description: '0 for a section heading, 1 for a sub-point. Defaults to 0.' },
            },
            required: [],
          },
        },
      },
      execute: async args => {
        const chapterName = String(args['chapterName'] ?? '').trim();
        const itemText = String(args['item'] ?? '').trim();
        const level = args['level'] === 1 ? 1 : 0;

        if (!itemText) {
          return {
            toolResult: {
              added: false,
              needItem: true,
              message: 'No outline item text was provided. Ask the user what text to add to the outline.',
            },
          };
        }

        const chapter = chapterName ? await resolveByTitle('chapter', chapterName, req) : null;
        if (!chapter) {
          return {
            toolResult: {
              added: false,
              needChapter: true,
              message: chapterName
                ? `No chapter matching "${chapterName}" was found. Ask the user which chapter to use.`
                : 'No chapter was specified. Ask the user which chapter to add the outline item to.',
            },
          };
        }

        const { resource: fullChapter } = await getContainer('chapters').item(chapter.id, chapter.id).read<Chapter>();
        if (!fullChapter) {
          return { toolResult: { added: false, message: 'Could not load the chapter.' } };
        }

        const now = new Date().toISOString();
        const email = req.user!.email;
        const newItem: OutlineItem = { id: randomUUID(), text: itemText, level };
        const updated: Chapter = {
          ...fullChapter,
          outline: [...(fullChapter.outline ?? []), newItem],
          modifiedBy: email,
          modifiedAt: now,
        };
        // Strip legacy whole-chapter vector (matches chapter PUT route behaviour).
        delete (updated as { contentVector?: unknown }).contentVector;
        try {
          await getContainer('chapters').item(chapter.id, chapter.id).replace<Chapter>(updated);
        } catch (err) {
          console.error('add_chapter_outline_item replace failed:', err);
          return { toolResult: { added: false, message: 'Failed to save the outline item. Please try again.' } };
        }

        return {
          toolResult: { added: true, chapter: chapter.title, item: itemText, level, message: `Outline item added to "${chapter.title}" successfully.` },
          sse: { chapterUpdated: { id: chapter.id, outline: updated.outline } },
          success: true,
        };
      },
    },
    generate_image: generateImageTool(),
  };
}

/** The image-generation tool, shared by series and quick chats. */
function generateImageTool(): ChatTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          'Generate an image from a text description and display it inline in the chat. Use this ' +
          'whenever the user asks you to draw, create, generate, paint, illustrate, or make a ' +
          'picture/image/illustration/artwork of something (e.g. "create me a drawing of the sun", ' +
          '"draw my character", "generate an image of a castle at dusk"). Pass "prompt" as a vivid, ' +
          'self-contained description of the image to create; expand terse requests into a richer ' +
          'visual description while staying faithful to what the user asked for.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'A detailed description of the image to generate.' },
          },
          required: ['prompt'],
        },
      },
    },
    // Image generation takes ~10–20s; tell the client to show a spinner first.
    pending: { generatingImage: true },
    execute: async args => {
      const prompt = String(args['prompt'] ?? '').trim();
      if (!prompt) {
        return { toolResult: { generated: false, message: 'No image description was provided.' } };
      }
      try {
        const { url, thumbnailUrl } = await generateImage(prompt);
        return {
          toolResult: { generated: true, message: 'The image has been generated and shown to the user.' },
          sse: { image: { url, thumbnailUrl, prompt } },
        };
      } catch (err) {
        console.error('generate_image tool error:', err);
        return {
          toolResult: { generated: false, message: 'Image generation failed. Apologize briefly to the user.' },
          sse: { imageError: true },
        };
      }
    },
  };
}

/** Tools available to the series-scoped Resource Manager chat. */
function seriesChatTools(req: Request): Record<string, ChatTool> {
  return {
    generate_image: generateImageTool(),
    research_entity: getResearchEntityTool(req),
  };
}

// GET / — list all session summaries for the authenticated user (newest first)
router.get('/', async (req: Request, res: Response) => {
  try {
    const container = getContainer('chat-sessions');
    const seriesId = req.query['seriesId'] as string | undefined;
    const params: any[] = [{ name: '@owner', value: req.user!.email }];
    let seriesFilter = '';
    if (seriesId) {
      seriesFilter = ' AND (c.seriesId = @seriesId OR IS_NULL(c.seriesId) OR NOT IS_DEFINED(c.seriesId))';
      params.push({ name: '@seriesId', value: seriesId });
    }
    const { resources } = await container.items
      .query({
        query: `SELECT c.id, c.name, c.pinned, c.folderId, c.seriesId, c.updatedAt FROM c
                WHERE c.owner = @owner
                  AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)
                  AND (NOT IS_DEFINED(c.archived) OR c.archived = false)${seriesFilter}
                ORDER BY c.updatedAt DESC`,
        parameters: params,
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error('Error listing chat sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// GET /archived — list archived sessions for the authenticated user
router.get('/archived', async (req: Request, res: Response) => {
  try {
    const container = getContainer('chat-sessions');
    const { resources } = await container.items
      .query({
        query: `SELECT c.id, c.name, c.updatedAt FROM c
                WHERE c.owner = @owner
                  AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)
                  AND c.archived = true
                ORDER BY c.updatedAt DESC`,
        parameters: [{ name: '@owner', value: req.user!.email }],
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error('Error listing archived chat sessions:', err);
    res.status(500).json({ error: 'Failed to list archived sessions' });
  }
});

// POST / — create a new session
router.post('/', async (req: Request, res: Response) => {
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    owner: req.user!.email,
    name: 'New Chat',
    pinned: false,
    folderId: req.body.folderId ?? null,
    seriesId: req.body.seriesId ?? null,
    chapterId: req.body.chapterId ?? null,
    messages: [],
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  try {
    const container = getContainer('chat-sessions');
    await container.items.create(session);
    res.json(session);
  } catch (err) {
    console.error('Error creating chat session:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// GET /by-chapter/:chapterId — list sessions pinned to a specific chapter
router.get('/by-chapter/:chapterId', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  try {
    const container = getContainer('chat-sessions');
    const { resources } = await container.items
      .query({
        query: `SELECT c.id, c.name, c.pinned, c.folderId, c.seriesId, c.chapterId, c.updatedAt FROM c
                WHERE c.owner = @owner
                  AND c.chapterId = @chapterId
                  AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)
                  AND (NOT IS_DEFINED(c.archived) OR c.archived = false)
                ORDER BY c.updatedAt DESC`,
        parameters: [
          { name: '@owner', value: req.user!.email },
          { name: '@chapterId', value: chapterId },
        ],
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error('Error listing chapter chat sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// GET /:id — get a full session (with messages)
router.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  try {
    const container = getContainer('chat-sessions');
    const { resource } = await container.item(id, id).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(resource);
  } catch {
    res.status(404).json({ error: 'Session not found' });
  }
});

// PUT /:id — update session fields (name, pinned, messages)
router.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  try {
    const container = getContainer('chat-sessions');
    const { resource } = await container.item(id, id).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const updated = {
      ...resource,
      ...(req.body.name !== undefined && { name: req.body.name }),
      ...(req.body.pinned !== undefined && { pinned: req.body.pinned }),
      ...(req.body.messages !== undefined && { messages: req.body.messages }),
      ...(req.body.folderId !== undefined && { folderId: req.body.folderId }),
      ...(req.body.chapterId !== undefined && { chapterId: req.body.chapterId }),
      updatedAt: new Date().toISOString(),
    };
    await container.items.upsert(updated);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating chat session:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// DELETE /:id — permanent soft-delete a session (called from archive screen)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  try {
    const container = getContainer('chat-sessions');
    const { resource } = await container.item(id, id).read<any>();
    if (!resource || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await container.items.upsert({
      ...resource,
      deleted: true,
      deletedAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting chat session:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// POST /:id/archive — move session to archive
router.post('/:id/archive', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  try {
    const container = getContainer('chat-sessions');
    const { resource } = await container.item(id, id).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await container.items.upsert({
      ...resource,
      archived: true,
      pinned: false,
      archivedAt: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error archiving chat session:', err);
    res.status(500).json({ error: 'Failed to archive session' });
  }
});

// POST /:id/restore — restore session from archive
router.post('/:id/restore', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  try {
    const container = getContainer('chat-sessions');
    const { resource } = await container.item(id, id).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await container.items.upsert({
      ...resource,
      archived: false,
      archivedAt: undefined,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error restoring chat session:', err);
    res.status(500).json({ error: 'Failed to restore session' });
  }
});

// POST /:id/chat — stream a chat message response
router.post('/:id/chat', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const messages: { role: 'user' | 'assistant'; content: string }[] = req.body.messages;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  let session: { seriesId?: string | null } | undefined;
  try {
    const container = getContainer('chat-sessions');
    const { resource } = await container.item(id, id).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    session = resource;
  } catch {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // RAG: retrieve the passages from across this series most relevant to the
  // question and ground the answer in them. Sessions are scoped to a series, so
  // search spans every chapter in every book of that series.
  const { systemPrompt, citations } = session?.seriesId
    ? await buildRagSystemPrompt(messages, { seriesId: session.seriesId }, req)
    : { systemPrompt: BASE_SYSTEM_PROMPT, citations: [] as ChapterCitation[] };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  await streamChatResponse(res, systemPrompt + IMAGE_TOOL_GUIDANCE + ENTITY_RESEARCH_GUIDANCE, messages, citations, seriesChatTools(req));
});

// POST /quick-chat — stateless RAG chat for the quick-launch overlay. Normally
// searches every chapter the user owns (no series scope) and never persists.
// When `chapterContext` is supplied (the overlay was opened from the chapter
// editor), it instead grounds the answer in the current chapter — book-scoped
// RAG, character voice, and the text surrounding the cursor — so the answer is
// suitable for inserting at the cursor, mirroring the old inline AI Insert.
router.post('/quick-chat', async (req: Request, res: Response) => {
  const messages: { role: 'user' | 'assistant'; content: string }[] = req.body.messages;
  const chapterContext = req.body.chapterContext as
    | { chapterId: string; surroundingText?: string; selectedText?: string; outline?: OutlineItem[]; notes?: ChapterNote[] }
    | undefined;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  let systemPrompt: string;
  let citations: ChapterCitation[] = [];

  // Whole-chapter drafting: when the author asks to "write the chapter", assemble
  // the rich continuity-aware context (prior chapters, cast, voice, canon) and
  // draft with the full model, no tools — just polished prose to insert.
  if (chapterContext?.chapterId) {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (isWholeChapterDraftRequest(lastUser?.content ?? '')) {
      const { systemPrompt: draftPrompt } = await buildChapterDraftingContext(
        chapterContext.chapterId,
        { outline: chapterContext.outline, notes: chapterContext.notes, instructionText: lastUser?.content ?? '' },
        req,
      );

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Flag the message as a chapter draft so the client offers
      // Insert / Replace chapter / Revise actions.
      res.write(`data: ${JSON.stringify({ chapterDraft: true })}\n\n`);

      // Stage 1: beat sheet (scene plan), surfaced to the client and fed into
      // the prose generation for structural coherence.
      const beats = await generateChapterBeatSheet(draftPrompt, lastUser?.content ?? '');
      if (beats) res.write(`data: ${JSON.stringify({ beats })}\n\n`);

      // Stage 2: full-model prose draft, grounded in the beat sheet.
      const prosePrompt = beats
        ? `${draftPrompt}\n\nFollow this beat sheet, expanding each beat into immersive prose:\n${beats}`
        : draftPrompt;
      await streamChatResponse(res, prosePrompt, messages, [], undefined, config.foundry.fullModel);
      return;
    }
  }

  if (chapterContext?.chapterId) {
    const { surroundingText, selectedText, outline, notes } = chapterContext;
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    const retrievalQuery = [selectedText, surroundingText, lastUserMessage?.content]
      .filter(Boolean).join('\n\n').trim();
    const { chapterTitle, contextSuffix } = await buildChapterContextPrompt(
      chapterContext.chapterId,
      { selectedText, retrievalQuery, instructionText: lastUserMessage?.content ?? '' },
      req,
    );

    const titlePart = chapterTitle ? ` chapter titled "${chapterTitle}"` : '';
    systemPrompt =
      `You are a helpful writing assistant helping an author with their story${titlePart}. ` +
      'When the author asks you to write or insert prose, provide only the requested content as plain ' +
      'prose — no markdown, no preamble, and no meta-commentary such as "Sure, here you go". The author ' +
      'will insert your answer directly into the chapter at their cursor.' +
      contextSuffix;

    if (outline && outline.length > 0) {
      const outlineText = outline.map(item => {
        const indent = item.level === 1 ? '  - ' : '- ';
        return `${indent}${item.text}`;
      }).join('\n');
      systemPrompt += `\n\nThe author has created the following outline for this chapter:\n${outlineText}`;
    }

    if (notes && notes.length > 0) {
      const notesText = notes.map(n =>
        n.selectedText
          ? `- [on "${n.selectedText}"]: ${n.noteText}`
          : `- ${n.noteText}`,
      ).join('\n');
      systemPrompt += `\n\nThe author has written the following notes for this chapter:\n${notesText}`;
    }

    if (surroundingText) {
      systemPrompt +=
        `\n\nThe text surrounding the author's cursor (the insertion point is marked [CURSOR]):\n` +
        `"${surroundingText}"\n\nUse it only as context. Do NOT repeat any of the surrounding text — ` +
        `return ONLY the new content to insert at the cursor.`;
    }
    if (selectedText) {
      systemPrompt += `\n\nThe author currently has this text selected:\n"${selectedText}"`;
    }
  } else {
    ({ systemPrompt, citations } = await buildRagSystemPrompt(messages, {}, req));
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const tools = chapterContext?.chapterId
    ? {
        ...quickChatTools(req),
        get_chapter_text: getChapterTextTool(chapterContext.chapterId, req),
        link_entity_references: getLinkEntityReferencesTool(req),
        propose_chapter_edit: getProposeChapterEditTool(chapterContext.chapterId, req),
      }
    : quickChatTools(req);
  const guidance =
    IMAGE_TOOL_GUIDANCE + ENTITY_RESEARCH_GUIDANCE + (chapterContext?.chapterId ? LINK_REFERENCES_GUIDANCE + SMART_EDIT_GUIDANCE : '');
  await streamChatResponse(res, systemPrompt + guidance, messages, citations, tools);
});

// POST /:id/name — ask the LLM to generate a session name, then persist it
router.post('/:id/name', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const messages: { role: 'user' | 'assistant'; content: string }[] = req.body.messages;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  let existingResource: any;
  try {
    const container = getContainer('chat-sessions');
    const { resource } = await container.item(id, id).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    existingResource = resource;
  } catch {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  try {
    const response = await client.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        {
          role: 'system',
          content:
            'Generate a concise, descriptive title (3 to 6 words) for this conversation based on the user\'s first message. Return only the title text — no punctuation at the end, no quotes, no explanation.',
        },
        ...messages.slice(0, 2),
      ],
      stream: false,
    });

    const name = response.choices[0]?.message?.content?.trim() ?? 'New Chat';

    // Re-read before upserting so we don't clobber messages that were saved
    // concurrently by persistToSession (which runs in parallel with this call).
    const container = getContainer('chat-sessions');
    const { resource: freshResource } = await container.item(id, id).read<any>();
    await container.items.upsert({
      ...(freshResource ?? existingResource),
      name,
      updatedAt: new Date().toISOString(),
    });
    res.json({ name });
  } catch (err) {
    console.error('Error generating session name:', err);
    res.status(500).json({ error: 'Failed to generate name' });
  }
});

export default router;
