import { AzureOpenAI } from 'openai';
import config from '../config';
import { Entity } from '../../shared/models/entity.model';
import { ChapterDialogue, DialogueParagraph, DialogueSpan, DialogueSpeakers } from '../../shared/models/dialogue.model';

let client: AzureOpenAI | null = null;
function llm(): AzureOpenAI {
  client ??= new AzureOpenAI({
    endpoint: config.foundry.endpoint,
    apiKey: config.foundry.key,
    apiVersion: config.foundry.apiVersion,
  });
  return client;
}

/** Paragraphs per model call. */
export const DIALOGUE_BATCH = 30;
/** Model calls in flight at once for one chapter. */
const CONCURRENCY = 3;

const SYSTEM_PROMPT =
  'You attribute dialogue in novel prose. Each paragraph has passages marked [[n]]…[[/n]]: quoted speech, ' +
  'or italic text that may be a character\'s unspoken thought. For every marked passage, give the id of the ' +
  'character who says or thinks it, judging by dialogue tags, who is present, turn-taking with the preceding ' +
  'context, and voice. Use the narrator\'s id for lines spoken or thought by a first-person narrator. ' +
  'Use null when the passage is not a character speaking or thinking (emphasis, a sign, a title, a word being ' +
  'discussed, scare quotes) or when you genuinely cannot tell. Use only ids from the character list. ' +
  'Reply with JSON: {"paragraphs":[{"id":"P1","speakers":["C2",null]}]} — one entry per paragraph, ' +
  'one speaker per marked passage, in order.';

function isContentFilterError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'content_filter';
}

/** The paragraph's text with its spans wrapped in [[n]]…[[/n]] markers. */
export function markSpans(text: string, spans: readonly DialogueSpan[]): string {
  let out = '';
  let at = 0;
  spans.forEach((s, i) => {
    out += `${text.slice(at, s.start)}[[${i + 1}]]${text.slice(s.start, s.end)}[[/${i + 1}]]`;
    at = s.end;
  });
  return out + text.slice(at);
}

function describe(entity: Entity, label: string): string {
  if (entity.isNarrator) return `${label}: the narrator (first-person point of view, if the story has one)`;
  const names = [entity.nickname, ...(entity.aliases ?? [])].filter(Boolean);
  const extra = [
    names.length ? `also called ${names.join(', ')}` : '',
    entity.gender ? entity.gender.toLowerCase() : '',
  ].filter(Boolean).join('; ');
  return `${label}: ${entity.name}${extra ? ` (${extra})` : ''}`;
}

export interface AttributeOptions {
  model: string;
  /** Characters (PERSON entities) of the series, including the narrator. */
  characters: readonly Entity[];
  /** Whose point of view the chapter is told from, when known. */
  povEntityId?: string;
}

/**
 * Asks the model who speaks each span of each paragraph. Returns speakers by
 * paragraph key for every paragraph the model answered for (a reply that
 * doesn't fit — wrong count, unknown id — becomes null speakers so the
 * paragraph isn't sent again). Paragraphs in a batch whose call failed are
 * left out, so the next save retries them.
 */
export async function attributeDialogue(paragraphs: readonly DialogueParagraph[], options: AttributeOptions): Promise<ChapterDialogue> {
  const labels = new Map<string, string>();
  const ids = new Map<string, string>();
  options.characters.forEach((c, i) => {
    const label = c.isNarrator ? 'N' : `C${i + 1}`;
    labels.set(c.id, label);
    ids.set(label, c.id);
  });
  const roster = options.characters.map(c => describe(c, labels.get(c.id)!)).join('\n');
  const pov = options.povEntityId && labels.get(options.povEntityId)
    ? `\nThis chapter is told from the point of view of ${labels.get(options.povEntityId)}.`
    : '';

  const batches: DialogueParagraph[][] = [];
  for (let i = 0; i < paragraphs.length; i += DIALOGUE_BATCH) batches.push(paragraphs.slice(i, i + DIALOGUE_BATCH));

  const result: ChapterDialogue = {};
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      try {
        Object.assign(result, await attributeBatch(batch, roster + pov, ids, options.model));
      } catch (err) {
        if (!isContentFilterError(err)) {
          console.error('Dialogue attribution batch failed:', err);
          continue;
        }
        // The content filter judges the batch as a whole: try each paragraph on
        // its own, and read any it still refuses in the narration voice rather
        // than sending it again on every save.
        for (const paragraph of batch) {
          try {
            Object.assign(result, await attributeBatch([paragraph], roster + pov, ids, options.model));
          } catch (inner) {
            if (!isContentFilterError(inner)) { console.error('Dialogue attribution failed:', inner); continue; }
            console.warn('Dialogue attribution: a paragraph trips the content filter; reading it as narration.');
            result[paragraph.key] = paragraph.spans.map(() => null);
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return result;
}

async function attributeBatch(
  batch: readonly DialogueParagraph[],
  roster: string,
  ids: ReadonlyMap<string, string>,
  model: string,
): Promise<ChapterDialogue> {
  const body = batch.map((p, i) => {
    const context = p.context ? `Preceding text: ${p.context}\n` : '';
    return `### P${i + 1}\n${context}Paragraph: ${markSpans(p.text, p.spans)}`;
  }).join('\n\n');
  const completion = await llm().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Characters:\n${roster}\n\n${body}` },
    ],
    response_format: { type: 'json_object' },
  });
  const raw = completion.choices[0]?.message?.content;
  let answered: { id?: unknown; speakers?: unknown }[] = [];
  try {
    const parsed = JSON.parse(raw ?? '{}') as { paragraphs?: unknown };
    if (Array.isArray(parsed.paragraphs)) answered = parsed.paragraphs;
  } catch {
    // Unreadable reply: every paragraph in the batch falls back to null speakers.
  }
  const byId = new Map(answered.map(a => [String(a.id ?? ''), a.speakers]));
  const out: ChapterDialogue = {};
  batch.forEach((p, i) => {
    const speakers = byId.get(`P${i + 1}`);
    out[p.key] = Array.isArray(speakers) && speakers.length === p.spans.length
      ? speakers.map(s => (typeof s === 'string' ? ids.get(s) ?? null : null))
      : p.spans.map(() => null);
  });
  return out;
}

/** Max paragraphs attributed per request, and characters per paragraph / context. */
export const MAX_PENDING = 500;
const MAX_TEXT = 4000;
const MAX_CONTEXT = 800;

/** Validates a client's paragraph list; returns null when it's malformed. */
export function readPending(value: unknown): DialogueParagraph[] | null {
  if (!Array.isArray(value)) return null;
  const out: DialogueParagraph[] = [];
  for (const item of value.slice(0, MAX_PENDING)) {
    const p = item as Partial<DialogueParagraph>;
    if (typeof p?.key !== 'string' || typeof p.text !== 'string' || !Array.isArray(p.spans)) return null;
    const text = p.text.slice(0, MAX_TEXT);
    const spans = p.spans.filter((s): s is DialogueSpan =>
      Number.isInteger(s?.start) && Number.isInteger(s?.end) && s.start >= 0 && s.end > s.start && s.end <= text.length);
    if (spans.length !== p.spans.length || !spans.length) return null;
    out.push({
      key: p.key.slice(0, 64),
      text,
      spans,
      ...(typeof p.context === 'string' && p.context ? { context: p.context.slice(-MAX_CONTEXT) } : {}),
    });
  }
  return out;
}

/** Keeps only the attributions for keys still in the chapter. */
export function pruneDialogue(dialogue: ChapterDialogue | undefined, keys: ReadonlySet<string>): ChapterDialogue {
  const out: ChapterDialogue = {};
  for (const [key, speakers] of Object.entries(dialogue ?? {})) {
    if (keys.has(key)) out[key] = speakers as DialogueSpeakers;
  }
  return out;
}
