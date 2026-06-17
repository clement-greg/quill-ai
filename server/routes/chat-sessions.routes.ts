import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import { randomUUID } from 'crypto';
import config from '../config';
import { getContainer } from '../cosmos';
import { withOwnerFilter } from '../owner-guard';
import { searchChapterChunks, reindexChapterChunks } from '../chapter-chunks';
import { Chapter } from '../../shared/models/chapter.model';
import { ChapterCitation } from '../../shared/models/chat-session.model';
import { generateImage } from '../image-generation';

/** A tool the model may call. `execute` returns the result fed back to the
 * model, plus an optional `sse` payload streamed to the client as a side effect
 * (e.g. a client-side navigation instruction). `pending`, when set, is streamed
 * to the client immediately before `execute` runs — useful for long-running
 * tools (e.g. image generation) so the UI can show progress. */
interface ChatTool {
  definition: unknown;
  pending?: object;
  execute: (args: Record<string, unknown>) => Promise<{ toolResult: unknown; sse?: object }>;
}

const router = Router();

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

const BASE_SYSTEM_PROMPT =
  'You are a helpful writing assistant. Help the author with their creative writing, worldbuilding, character development, plot structure, dialogue, and any other writing-related questions. Format responses using markdown where appropriate.';

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
    `- If the excerpts don't contain the answer, say so rather than inventing details.\n\n` +
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
): Promise<void> {
  // The running conversation; grows as tool calls/results are appended.
  const convo: unknown[] = [{ role: 'system', content: systemPrompt }, ...messages];
  const toolDefinitions = tools ? Object.values(tools).map(t => t.definition) : undefined;

  try {
    // Bounded loop: model turn → optional tool calls → model turn → … → answer.
    for (let turn = 0; turn < 4; turn++) {
      const stream = await client.chat.completions.create({
        model: config.foundry.miniModel,
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
        const { toolResult, sse } = tool
          ? await tool.execute(parsedArgs)
          : { toolResult: { error: `Unknown tool ${c.name}` }, sse: undefined };
        if (sse) res.write(`data: ${JSON.stringify(sse)}\n\n`);
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

type EntityNameRecord = { id: string; name?: string; firstName?: string; lastName?: string; nickname?: string };

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
    .query<EntityNameRecord>(withOwnerFilter(req, `SELECT c.id, c.name, c.firstName, c.lastName, c.nickname FROM c WHERE ${NOT_HIDDEN}`))
    .fetchAll();
  let best: TitleMatch | null = null;
  for (const e of resources) {
    const aliases = [e.name, e.firstName, e.lastName, e.nickname, [e.firstName, e.lastName].filter(Boolean).join(' ')]
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

/** Lists the user's (non-hidden) books as {id, title}. */
async function listBooks(req: Request): Promise<{ id: string; title: string }[]> {
  const { resources } = await getContainer('books').items
    .query<TitledRecord>(withOwnerFilter(req, `SELECT c.id, c.title FROM c WHERE ${NOT_HIDDEN}`))
    .fetchAll();
  return resources.map(r => ({ id: r.id, title: r.title ?? '' })).filter(b => b.title);
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

/** Creates a chapter at the end of the given book and indexes it for search. */
async function createChapterInBook(bookId: string, title: string, req: Request): Promise<{ id: string; title: string }> {
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
  const chapter: Chapter = {
    id: randomUUID(),
    title,
    bookId,
    content: '',
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

/** Tools available to the quick-chat (cross-series) assistant. */
function quickChatTools(req: Request): Record<string, ChatTool> {
  return {
    create_chapter: {
      definition: {
        type: 'function',
        function: {
          name: 'create_chapter',
          description:
            'Create a new chapter for the user and open it. Extract details from the user\'s phrasing: pass ' +
            '"title" when they name the chapter (e.g. "create a chapter called \'Joining the Fray\'" → title ' +
            '"Joining the Fray"), and "bookName" when they say which book (e.g. "...in Lithium" → bookName ' +
            '"Lithium"). If the user did NOT indicate a book, call this WITHOUT bookName — the tool will return ' +
            'the list of books so you can ask the user which one, then call it again with their choice. Do not ' +
            'invent a title the user did not provide.',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The chapter title, if the user provided one.' },
              bookName: { type: 'string', description: 'The book to create the chapter in, if the user indicated one.' },
            },
            required: [],
          },
        },
      },
      execute: async args => {
        const title = String(args['title'] ?? '').trim();
        const bookName = String(args['bookName'] ?? '').trim();

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

        const created = await createChapterInBook(book.id, title || 'Untitled Chapter', req);
        return {
          toolResult: { created: true, chapterId: created.id, title: created.title, book: book.title },
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
function seriesChatTools(): Record<string, ChatTool> {
  return {
    generate_image: generateImageTool(),
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
      seriesFilter = ' AND c.seriesId = @seriesId';
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

  await streamChatResponse(res, systemPrompt + IMAGE_TOOL_GUIDANCE, messages, citations, seriesChatTools());
});

// POST /quick-chat — stateless, cross-series RAG chat for the quick-launch
// overlay. Searches every chapter the user owns (no series scope) and never
// persists; the client decides whether to save the conversation afterwards.
router.post('/quick-chat', async (req: Request, res: Response) => {
  const messages: { role: 'user' | 'assistant'; content: string }[] = req.body.messages;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  const { systemPrompt, citations } = await buildRagSystemPrompt(messages, {}, req);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  await streamChatResponse(res, systemPrompt + IMAGE_TOOL_GUIDANCE, messages, citations, quickChatTools(req));
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

    const container = getContainer('chat-sessions');
    await container.items.upsert({
      ...existingResource,
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
