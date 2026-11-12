/**
 * Who speaks each line of dialogue in a chapter, so read-aloud can give
 * characters their own voices.
 *
 * A paragraph's "dialogue spans" are its quoted passages (straight or curly
 * double quotes) plus longer italic runs (unquoted thoughts). A paragraph is
 * keyed by a hash of its text and those span positions, so any edit to it —
 * including to a quote — gives it a new key: its old speakers no longer apply
 * and only that paragraph is attributed again on the next save.
 */

/** A dialogue passage: [start, end) in the paragraph's normalized text. */
export interface DialogueSpan {
  start: number;
  end: number;
}

/** Speaker entity id for each of a paragraph's spans, in order (null = narration voice). */
export type DialogueSpeakers = (string | null)[];

/** A chapter's attributions: paragraph key → speakers. */
export type ChapterDialogue = Record<string, DialogueSpeakers>;

/** A paragraph the client wants attributed (POST /api/chapters/:id/dialogue). */
export interface DialogueParagraph {
  key: string;
  text: string;
  spans: DialogueSpan[];
  /** The paragraphs just before it, so the model can follow who's talking. */
  context?: string;
}

export interface DialogueTagRequest {
  /** Every dialogue paragraph's key in the chapter now; attributions for other keys are dropped. */
  keys: string[];
  /** Paragraphs the client has no attribution for. */
  pending: DialogueParagraph[];
}

/** Italic runs shorter than this many words are emphasis, not thoughts. */
export const MIN_THOUGHT_WORDS = 3;

/** Quoted passages, including their quote marks. An unclosed quote runs to the
 *  end of the paragraph (speech that carries on into the next one). */
export function findQuoteSpans(text: string): DialogueSpan[] {
  const spans: DialogueSpan[] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '“' || (c === '"' && open < 0)) {
      if (open < 0) open = i;
    } else if ((c === '”' || c === '"') && open >= 0) {
      if (i > open + 1) spans.push({ start: open, end: i + 1 });
      open = -1;
    }
  }
  if (open >= 0 && open < text.length - 1) spans.push({ start: open, end: text.length });
  return spans;
}

/**
 * The paragraph's dialogue spans: its quotes, plus italic runs of at least
 * MIN_THOUGHT_WORDS words that don't overlap a quote, in reading order.
 */
export function dialogueSpans(text: string, italics: readonly DialogueSpan[] = []): DialogueSpan[] {
  const quotes = findQuoteSpans(text);
  const thoughts = italics
    .map(r => trimSpan(text, r))
    .filter((r): r is DialogueSpan => r !== null)
    .filter(r => text.slice(r.start, r.end).split(/\s+/).filter(Boolean).length >= MIN_THOUGHT_WORDS)
    .filter(r => !quotes.some(q => r.start < q.end && q.start < r.end));
  return [...quotes, ...thoughts].sort((a, b) => a.start - b.start);
}

function trimSpan(text: string, span: DialogueSpan): DialogueSpan | null {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return end > start ? { start, end } : null;
}

/** Stable key for a paragraph's text and dialogue spans (53-bit FNV-style hash, base 36). */
export function dialogueKey(text: string, spans: readonly DialogueSpan[]): string {
  const input = `${text}|${spans.map(s => `${s.start}-${s.end}`).join(',')}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A run of a paragraph to speak in one voice (null = the narration voice). */
export interface VoicedPart {
  text: string;
  voiceId: string | null;
}

/**
 * Splits a paragraph into runs by voice: each span whose speaker has a voice
 * gets that voice; everything else (narration, unattributed quotes, characters
 * without a voice) gets null. Adjacent runs in the same voice are merged.
 * Returns null when the whole paragraph is narration.
 */
export function voicedParts(
  text: string,
  spans: readonly DialogueSpan[],
  speakers: DialogueSpeakers | undefined,
  voiceFor: (entityId: string) => string | null | undefined,
): VoicedPart[] | null {
  if (!speakers || speakers.length !== spans.length) return null;
  const parts: VoicedPart[] = [];
  const push = (from: number, to: number, voiceId: string | null) => {
    if (to <= from) return;
    const last = parts.at(-1);
    if (last && last.voiceId === voiceId) last.text += text.slice(from, to);
    else parts.push({ text: text.slice(from, to), voiceId });
  };
  let at = 0;
  spans.forEach((span, i) => {
    const speaker = speakers[i];
    const voice = speaker ? voiceFor(speaker) ?? null : null;
    push(at, span.start, null);
    push(span.start, span.end, voice);
    at = span.end;
  });
  push(at, text.length, null);
  return parts.some(p => p.voiceId) ? parts : null;
}
