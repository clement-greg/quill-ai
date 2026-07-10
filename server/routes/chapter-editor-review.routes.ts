import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import { randomUUID } from 'crypto';
import config from '../config';
import { buildChapterContext } from '../services/chapter-drafting-context';
import {
  EditorReviewBlock,
  EditorSuggestion,
  SuggestionCategory,
  SuggestionSeverity,
  SuggestionType,
} from '../../shared/models/editor-review.model';

const router = Router();

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

const VALID_CATEGORIES: ReadonlySet<string> = new Set<SuggestionCategory>([
  'grammar', 'punctuation', 'word-choice', 'flow', 'clarity', 'repetition',
  'pacing', 'description', 'dialogue', 'tension', 'plot',
  'continuity', 'voice', 'character', 'other',
]);
const VALID_SEVERITIES: ReadonlySet<string> = new Set<SuggestionSeverity>([
  'low', 'medium', 'high',
]);

/**
 * The editorial system prompt: a full developmental + line-editing pass across
 * four lenses, grounded in the chapter's context (series voice, story-so-far,
 * character bios, continuity passages). Returns one suggestion per line (JSONL)
 * so the client can surface edits progressively as the review walks the chapter.
 */
function buildEditorPrompt(blocks: EditorReviewBlock[], contextText: string): string {
  const numbered = blocks.map(b => `[${b.index}] ${b.text}`).join('\n\n');
  const contextBlock = contextText
    ? `\n\nCONTEXT — the story's established voice, characters, and continuity. ` +
      `Use it to judge consistency and voice; do NOT treat it as text to edit:\n${contextText}\n`
    : '';

  return (
    `You are a seasoned fiction editor doing an editorial pass on one chapter of a novel. ` +
    `Act like a real editor: improve the prose while preserving the author's voice and intent.${contextBlock}\n\n` +
    `Review through FOUR lenses:\n` +
    `1. COPY / LINE EDITING — grammar, punctuation, word choice, awkward flow, wordiness, ` +
    `clarity, unintentional repetition.\n` +
    `2. DEVELOPMENTAL / CONTENT — pacing, tension, weak or missing sensory detail, telling vs. ` +
    `showing, flat dialogue, structural gaps.\n` +
    `3. CONSISTENCY / CONTINUITY — contradictions with the CONTEXT above (character facts, ` +
    `established events, timeline, names) or within this chapter.\n` +
    `4. STYLE / VOICE — prose that drifts from the series style or the point-of-view character's ` +
    `established voice.\n\n` +
    `The chapter is given as numbered blocks:\n\n${numbered}\n\n` +
    `OUTPUT FORMAT — follow EXACTLY:\n` +
    `- Output ONLY a stream of JSON objects, ONE per line (JSONL). No prose, no markdown, no code ` +
    `fences, no surrounding array.\n` +
    `- Each line is one suggestion with these fields:\n` +
    `  {"blockIndex": <number>, "type": <"replace"|"comment">, "originalText": <string>, ` +
    `"replacementText": <string>, "category": <category>, "severity": <"low"|"medium"|"high">, ` +
    `"reason": <string>}\n` +
    `- Use "type":"replace" when you can propose a concrete rewrite of specific words. ` +
    `"originalText" MUST be copied VERBATIM from the block (exact substring, original casing and ` +
    `punctuation); "replacementText" is what it should become. To ADD a sentence, use a replace ` +
    `whose originalText is the adjacent sentence and whose replacementText includes that sentence ` +
    `plus the new one.\n` +
    `- Use "type":"comment" for higher-level notes you can't express as a literal swap (pacing, a ` +
    `continuity contradiction, "consider adding sensory detail here"). Set "originalText" to a SHORT ` +
    `verbatim substring marking where the note applies, omit or empty "replacementText", and put the ` +
    `note in "reason".\n` +
    `- "blockIndex" MUST be one of the bracketed numbers. Keep "originalText" short — just enough to ` +
    `locate uniquely.\n` +
    `- "category" is one of: grammar, punctuation, word-choice, flow, clarity, repetition, pacing, ` +
    `description, dialogue, tension, plot, continuity, voice, character.\n` +
    `- "severity": "high" for errors/contradictions, "medium" for clear improvements, "low" for ` +
    `optional polish.\n` +
    `- Prioritize quality over quantity. If a block needs nothing, emit nothing for it.`
  );
}

/** Validates and normalizes a raw model object into an EditorSuggestion, or
 * returns null when malformed or unanchorable to a known block. */
function toSuggestion(raw: unknown, blocksByIndex: Map<number, string>): EditorSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const blockIndex = typeof o['blockIndex'] === 'number' ? o['blockIndex'] : Number(o['blockIndex']);
  if (!Number.isInteger(blockIndex)) return null;

  const blockText = blocksByIndex.get(blockIndex);
  if (blockText === undefined) return null;

  const originalText = typeof o['originalText'] === 'string' ? o['originalText'] : '';
  if (!originalText) return null;
  // The anchor must exist in the block, else the client can't locate it.
  if (!blockText.includes(originalText)) return null;

  const rawType = typeof o['type'] === 'string' ? o['type'] : 'replace';
  const type: SuggestionType = rawType === 'comment' ? 'comment' : 'replace';

  const replacementText = typeof o['replacementText'] === 'string' ? o['replacementText'] : '';
  if (type === 'replace') {
    // A concrete edit needs a non-identical replacement.
    if (!replacementText || replacementText === originalText) return null;
  }

  const category = (typeof o['category'] === 'string' && VALID_CATEGORIES.has(o['category']))
    ? (o['category'] as SuggestionCategory)
    : 'other';
  const severity = (typeof o['severity'] === 'string' && VALID_SEVERITIES.has(o['severity']))
    ? (o['severity'] as SuggestionSeverity)
    : 'medium';
  const reason = typeof o['reason'] === 'string' ? o['reason'] : '';
  // A comment with no rationale is useless.
  if (type === 'comment' && !reason) return null;

  return {
    id: randomUUID(),
    blockIndex,
    originalText,
    ...(type === 'replace' ? { replacementText } : {}),
    type,
    category,
    severity,
    reason,
  };
}

/**
 * POST /api/chapter-editor-review
 * Streams editorial suggestions for a chapter as SSE. Body:
 *   { chapterId: string, blocks: { index: number; text: string }[] }
 * Emits `data: {"suggestion": EditorSuggestion}` per accepted suggestion, then
 * `data: [DONE]`.
 */
router.post('/', async (req: Request, res: Response) => {
  const chapterId: string = typeof req.body?.chapterId === 'string' ? req.body.chapterId : '';
  const blocks: EditorReviewBlock[] = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
  const cleanBlocks = blocks.filter(
    b => b && typeof b.index === 'number' && typeof b.text === 'string' && b.text.trim().length > 0,
  );

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (cleanBlocks.length === 0) {
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  const blocksByIndex = new Map<number, string>(cleanBlocks.map(b => [b.index, b.text]));

  try {
    // Ground the pass in the chapter's voice, cast and continuity (best-effort).
    let contextText = '';
    if (chapterId) {
      try {
        ({ contextText } = await buildChapterContext(chapterId, { instructionText: 'editorial review' }, req));
      } catch (err) {
        console.error('Editor review: failed to build context, continuing without it:', err);
      }
    }

    const stream = await client.chat.completions.create({
      model: config.foundry.fullModel,
      messages: [
        { role: 'system', content: buildEditorPrompt(cleanBlocks, contextText) },
        { role: 'user', content: 'Review the chapter and emit editorial suggestions as JSONL.' },
      ],
      stream: true,
    });

    // Accumulate streamed tokens and emit each complete JSONL line as it lands.
    let buffer = '';
    const emitLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('```') || !trimmed.startsWith('{')) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return; // Incomplete/garbled line — skip it.
      }
      const suggestion = toSuggestion(parsed, blocksByIndex);
      if (suggestion) res.write(`data: ${JSON.stringify({ suggestion })}\n\n`);
    };
    const flushLines = (final = false): void => {
      let nlIndex: number;
      while ((nlIndex = buffer.indexOf('\n')) !== -1) {
        emitLine(buffer.slice(0, nlIndex));
        buffer = buffer.slice(nlIndex + 1);
      }
      if (final && buffer.trim()) {
        emitLine(buffer);
        buffer = '';
      }
    };

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        buffer += delta;
        flushLines();
      }
    }
    flushLines(true);

    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('Chapter editor review streaming error:', err);
    const isContentFilter = (err as { code?: string })?.code === 'content_filter';
    const errorMessage = isContentFilter
      ? 'Your chapter was blocked by the content filter. Try again on a different section.'
      : 'AI error occurred during review';
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  } finally {
    res.end();
  }
});

/** Parses a single JSON object out of a model reply, tolerating code fences. */
function parseSingleJson(text: string): Record<string, unknown> | null {
  const stripped = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
  }
  return null;
}

/**
 * POST /api/chapter-editor-review/refine
 * Re-works a single suggestion per a free-form author instruction. Body:
 *   { blockText, originalText, currentReplacement?, reason?, type?, instruction }
 * The anchor (`originalText`) is held fixed so the client can still locate it;
 * only the replacement, reason, category and severity may change. Returns
 *   { suggestion: { type, replacementText, reason, category, severity } }.
 */
router.post('/refine', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const blockText: string = typeof body.blockText === 'string' ? body.blockText : '';
  const originalText: string = typeof body.originalText === 'string' ? body.originalText : '';
  const currentReplacement: string = typeof body.currentReplacement === 'string' ? body.currentReplacement : '';
  const priorReason: string = typeof body.reason === 'string' ? body.reason : '';
  const instruction: string = typeof body.instruction === 'string' ? body.instruction.trim() : '';

  if (!blockText || !originalText || !instruction) {
    res.status(400).json({ error: 'Missing blockText, originalText or instruction.' });
    return;
  }

  const systemPrompt =
    `You are a fiction editor refining a single edit you proposed, per the author's instruction. ` +
    `Return the revised edit as ONE JSON object and nothing else.\n\n` +
    `The passage (for context):\n"${blockText}"\n\n` +
    `The text under edit (keep this EXACTLY as the anchor):\n"${originalText}"\n` +
    (currentReplacement ? `Your current proposed replacement:\n"${currentReplacement}"\n` : '') +
    (priorReason ? `Your current rationale:\n"${priorReason}"\n` : '') +
    `\nAuthor's instruction:\n"${instruction}"\n\n` +
    `Output ONLY this JSON (no prose, no code fences):\n` +
    `{"type":"replace","replacementText":<string>,"category":<category>,` +
    `"severity":<"low"|"medium"|"high">,"reason":<string>}\n` +
    `- "replacementText" is the new text that should replace the anchor above, honoring the ` +
    `instruction while keeping the author's voice.\n` +
    `- Keep the change scoped to the anchored text; do not rewrite the whole passage.\n` +
    `- "category" is one of: grammar, punctuation, word-choice, flow, clarity, repetition, pacing, ` +
    `description, dialogue, tension, plot, continuity, voice, character.\n` +
    `- "reason" is one concise sentence explaining the revised edit.`;

  try {
    const response = await client.chat.completions.create({
      model: config.foundry.fullModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: instruction },
      ],
      stream: false,
    });
    const parsed = parseSingleJson(response.choices[0]?.message?.content ?? '');
    const replacementText = parsed && typeof parsed['replacementText'] === 'string'
      ? (parsed['replacementText'] as string) : '';
    if (!replacementText) {
      res.status(502).json({ error: "The editor couldn't refine that — try rephrasing." });
      return;
    }
    const category = (parsed && typeof parsed['category'] === 'string' && VALID_CATEGORIES.has(parsed['category']))
      ? (parsed['category'] as SuggestionCategory)
      : (typeof body.category === 'string' && VALID_CATEGORIES.has(body.category) ? body.category as SuggestionCategory : 'other');
    const severity = (parsed && typeof parsed['severity'] === 'string' && VALID_SEVERITIES.has(parsed['severity']))
      ? (parsed['severity'] as SuggestionSeverity)
      : (typeof body.severity === 'string' && VALID_SEVERITIES.has(body.severity) ? body.severity as SuggestionSeverity : 'medium');
    const reason = parsed && typeof parsed['reason'] === 'string' ? (parsed['reason'] as string) : priorReason;

    res.json({ suggestion: { type: 'replace' as SuggestionType, replacementText, category, severity, reason } });
  } catch (err) {
    console.error('Chapter editor review refine error:', err);
    res.status(500).json({ error: 'AI error occurred while refining.' });
  }
});

export default router;
