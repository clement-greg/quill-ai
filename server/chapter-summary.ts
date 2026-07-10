import { createHash } from 'crypto';
import { AzureOpenAI } from 'openai';
import config from './config';
import { getContainer } from './cosmos';
import { sanitizeForModeration } from './content-sanitize';
import { Chapter } from '../shared/models/chapter.model';

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

const SUMMARY_SYSTEM_PROMPT =
  'You summarize a single chapter of a novel for use as a continuity reference while ' +
  'the author drafts later chapters. Write 2-4 sentences in the present tense, plot-focused: ' +
  'who appears, what materially happens, and how the chapter ends. Capture consequential ' +
  'events (deaths, reveals, decisions, arrivals/departures, changes in relationships). ' +
  'Do NOT editorialize, do NOT mention "this chapter", and do NOT add commentary. ' +
  'Return only the summary prose.';

/**
 * Strips HTML tags to plain text, preserving paragraph boundaries as blank
 * lines (needed so a filtered summary request can be retried paragraph by
 * paragraph -- see generateChapterSummary).
 */
function toPlainText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .split(/\n{2,}/)
    .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Stable hash of the plain-text content, used to detect meaningful changes. */
function hashContent(plainText: string): string {
  return createHash('sha1').update(plainText).digest('hex');
}

function isContentFilterError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'content_filter';
}

async function requestSummary(input: string): Promise<string | null> {
  const response = await client.chat.completions.create({
    model: config.foundry.miniModel,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: input },
    ],
    stream: false,
  });
  return response.choices[0]?.message?.content?.trim() ?? null;
}

/**
 * Cheap 1-token probe to check whether a prompt alone would be blocked by the
 * content filter, without paying for a full completion.
 */
async function isPromptSafe(input: string): Promise<boolean> {
  try {
    await client.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [{ role: 'user', content: input }],
      max_tokens: 1,
      stream: false,
    });
    return true;
  } catch (err) {
    if (isContentFilterError(err)) return false;
    throw err;
  }
}

/**
 * Generates a short synopsis for a chapter and returns it along with the hash of
 * the content it was generated from. Returns null when there's nothing to
 * summarize or the AI call fails (callers should leave the existing summary in
 * place on null).
 */
export async function generateChapterSummary(
  content: string | undefined,
): Promise<{ summary: string; sourceHash: string } | null> {
  const plainText = toPlainText(content ?? '');
  if (plainText.length < 200) return null; // too short to be worth summarizing

  // Cap input so a very long chapter doesn't blow the context window; the head
  // and tail carry most of the plot-relevant signal for a synopsis.
  const MAX = 16000;
  const truncated = plainText.length > MAX
    ? `${plainText.slice(0, MAX * 0.7)}\n[...]\n${plainText.slice(-MAX * 0.3)}`
    : plainText;
  const input = await sanitizeForModeration(truncated);

  try {
    const summary = await requestSummary(input);
    if (!summary) return null;
    return { summary, sourceHash: hashContent(plainText) };
  } catch (err) {
    if (!isContentFilterError(err)) {
      console.error('Failed to generate chapter summary:', err);
      return null;
    }
    console.warn('Chapter summary input filtered; isolating offending paragraph(s).');
  }

  // The content filter reacts to the scene as a whole, not just a word --
  // find and drop whichever paragraph(s) it objects to so the rest of the
  // chapter still gets summarized.
  const paragraphs = input.split(/\n{2,}/).filter(Boolean);
  if (paragraphs.length <= 1) return null; // nothing left to isolate

  const survivors: string[] = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    try {
      if (await isPromptSafe(paragraph)) {
        survivors.push(paragraph);
      } else {
        const preview = paragraph.length > 200 ? `${paragraph.slice(0, 200)}...` : paragraph;
        console.warn(
          `Omitting paragraph ${index + 1}/${paragraphs.length} that trips the content filter from the chapter summary input:\n${preview}`,
        );
      }
    } catch (err) {
      console.error('Content filter probe failed; keeping paragraph:', err);
      survivors.push(paragraph);
    }
  }
  if (survivors.length === 0) return null;

  try {
    const summary = await requestSummary(survivors.join('\n\n'));
    if (!summary) return null;
    return { summary, sourceHash: hashContent(plainText) };
  } catch (err) {
    console.error('Chapter summary still filtered after omitting flagged paragraphs:', err);
    return null;
  }
}

/** Returns true when the chapter's stored summary is missing or stale relative
 * to its current content. */
export function summaryIsStale(chapter: Chapter): boolean {
  const plainText = toPlainText(chapter.content ?? '');
  if (plainText.length < 200) return false; // nothing meaningful to summarize
  if (!chapter.summary) return true;
  return chapter.summarySourceHash !== hashContent(plainText);
}

/**
 * Regenerates a chapter's summary if stale and persists it back to the document.
 * Fire-and-forget friendly: never throws, mirrors reindexChapterChunks so a
 * chapter save is never blocked by the AI service. Returns the new summary, or
 * null if unchanged/failed.
 */
export async function refreshChapterSummary(chapter: Chapter): Promise<string | null> {
  try {
    if (!summaryIsStale(chapter)) return null;
    const result = await generateChapterSummary(chapter.content);
    if (!result) return null;

    // Re-read before writing so we don't clobber a concurrent content edit.
    const container = getContainer('chapters');
    const { resource: fresh } = await container.item(chapter.id, chapter.id).read<Chapter>();
    if (!fresh) return null;
    await container.item(chapter.id, chapter.id).replace<Chapter>({
      ...fresh,
      summary: result.summary,
      summarySourceHash: result.sourceHash,
    });
    return result.summary;
  } catch (err) {
    console.error(`Failed to refresh summary for chapter ${chapter.id}:`, err);
    return null;
  }
}

/**
 * Ensures a chapter has a current summary, generating one on demand if missing
 * or stale. Used by the drafting-context assembler for lazy backfill of chapters
 * saved before summaries existed. Returns the best available summary (possibly
 * the existing stale one) or null.
 */
export async function ensureChapterSummary(chapter: Chapter): Promise<string | null> {
  if (!summaryIsStale(chapter)) return chapter.summary ?? null;
  const refreshed = await refreshChapterSummary(chapter);
  return refreshed ?? chapter.summary ?? null;
}
