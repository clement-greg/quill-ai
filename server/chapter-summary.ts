import { createHash } from 'crypto';
import { AzureOpenAI } from 'openai';
import config from './config';
import { getContainer } from './cosmos';
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

/** Strips HTML tags and collapses whitespace to plain text. */
function toPlainText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Stable hash of the plain-text content, used to detect meaningful changes. */
function hashContent(plainText: string): string {
  return createHash('sha1').update(plainText).digest('hex');
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
  const input = plainText.length > MAX
    ? `${plainText.slice(0, MAX * 0.7)}\n[...]\n${plainText.slice(-MAX * 0.3)}`
    : plainText;

  try {
    const response = await client.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: input },
      ],
      stream: false,
    });
    const summary = response.choices[0]?.message?.content?.trim();
    if (!summary) return null;
    return { summary, sourceHash: hashContent(plainText) };
  } catch (err) {
    console.error('Failed to generate chapter summary:', err);
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
