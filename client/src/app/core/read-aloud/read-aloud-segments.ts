import { parseContentBlocks } from '@app/features/chapters/chapter-edit/chapter-content-blocks';
import { voicedParts } from '@shared/models/dialogue.model';
import { dialogueBlocks } from './dialogue-paragraphs';
import { ReadAloudCast, ReadAloudChapter, ReadAloudSegment, ReadAloudVoice, VoiceQuality } from './read-aloud.model';

/**
 * Turns chapters into a flat play queue: each chapter's title, then its
 * paragraphs. With a cast, dialogue attributed to a character who has a voice
 * is split out into `parts` in that voice; everything else stays narration.
 */
export function buildSegments(chapters: readonly ReadAloudChapter[], cast?: ReadAloudCast | null): ReadAloudSegment[] {
  const out: ReadAloudSegment[] = [];
  const voices = cast?.voices ?? {};
  const hasVoices = Object.keys(voices).length > 0;
  chapters.forEach((ch, chapterIndex) => {
    const chapterTitle = ch.title.trim() || 'Untitled chapter';
    const base = { chapterId: ch.id, chapterIndex, chapterTitle };
    out.push({ ...base, blockIndex: -1, text: chapterTitle });
    const dialogue = hasVoices && ch.dialogue && Object.keys(ch.dialogue).length ? ch.dialogue : null;
    if (!dialogue) {
      parseContentBlocks(ch.html).forEach((block, blockIndex) => {
        out.push({ ...base, blockIndex, text: block.text });
      });
      return;
    }
    dialogueBlocks(ch.html).forEach((block, blockIndex) => {
      const parts = block.key ? voicedParts(block.text, block.spans, dialogue[block.key], id => voices[id]) : null;
      out.push({ ...base, blockIndex, text: block.text, ...(parts ? { parts } : {}) });
    });
  });
  return out;
}

/** Index of the segment for the given chapter (and paragraph, if given and present). */
export function findSegmentIndex(
  segments: readonly ReadAloudSegment[],
  chapterId: string,
  blockIndex?: number | null,
): number {
  const first = segments.findIndex(s => s.chapterId === chapterId);
  if (first < 0) return 0;
  if (blockIndex == null || blockIndex < 0) return first;
  const exact = segments.findIndex(s => s.chapterId === chapterId && s.blockIndex === blockIndex);
  return exact < 0 ? first : exact;
}

/** First segment of the chapter after the one playing at `index`, or -1 at the last chapter. */
export function nextChapterStart(segments: readonly ReadAloudSegment[], index: number): number {
  const current = segments[index]?.chapterIndex;
  if (current == null) return -1;
  return segments.findIndex((s, i) => i > index && s.chapterIndex !== current);
}

/** Like a music player's "previous": restarts this chapter, or goes back one
 *  chapter when already at (or within a paragraph of) its start. */
export function previousChapterStart(segments: readonly ReadAloudSegment[], index: number): number {
  const current = segments[index];
  if (!current) return 0;
  const start = segments.findIndex(s => s.chapterIndex === current.chapterIndex);
  if (index - start > 1 || current.chapterIndex === 0) return start;
  const prev = segments.findIndex(s => s.chapterIndex === current.chapterIndex - 1);
  return prev < 0 ? start : prev;
}

const SENTENCE = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g;

/**
 * Splits text into chunks of at most `max` characters, breaking between
 * sentences where possible. Browsers drop or cut off long utterances (Chrome
 * stops after ~15 seconds), so the web engine speaks one chunk at a time.
 */
export function splitIntoChunks(text: string, max = 200): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(SENTENCE)?.map(s => s.trim()).filter(Boolean) ?? [clean];
  const pieces = sentences.flatMap(s => (s.length <= max ? [s] : splitLong(s, max)));
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= max) chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

/** Breaks one long sentence at commas/semicolons, then at spaces, then anywhere. */
function splitLong(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    cut = cut > max / 3 ? cut + 1 : window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const QUALITY_RANK: Record<VoiceQuality, number> = { premium: 0, enhanced: 1, default: 2 };

/** Voices in the reader's language, best quality first, then by name. */
export function sortVoices(voices: readonly ReadAloudVoice[], language: string): ReadAloudVoice[] {
  const primary = language.toLowerCase().split('-')[0] ?? 'en';
  const exact = language.toLowerCase();
  return voices
    .filter(v => v.lang.toLowerCase().replace('_', '-').split('-')[0] === primary)
    .sort((a, b) =>
      QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality] ||
      Number(b.lang.toLowerCase().replace('_', '-') === exact) - Number(a.lang.toLowerCase().replace('_', '-') === exact) ||
      a.name.localeCompare(b.name));
}

/** A chapter's run of segments in the queue: [start, end). */
export interface ChapterSpan {
  chapterIndex: number;
  chapterId: string;
  title: string;
  start: number;
  end: number;
}

/** The queue's chapters in order, with where each starts and ends. */
export function chapterSpans(segments: readonly ReadAloudSegment[]): ChapterSpan[] {
  const spans: ChapterSpan[] = [];
  segments.forEach((s, i) => {
    const last = spans.at(-1);
    if (last && last.chapterIndex === s.chapterIndex) last.end = i + 1;
    else spans.push({ chapterIndex: s.chapterIndex, chapterId: s.chapterId, title: s.chapterTitle, start: i, end: i + 1 });
  });
  return spans;
}

/** Roughly how fast the voices speak at 1×; only used for time estimates. */
const WORDS_PER_MINUTE = 170;

/** Estimated seconds to speak a segment at 1×, including the pause after it. */
export function estimateSeconds(segment: ReadAloudSegment): number {
  const words = segment.text.split(/\s+/).filter(Boolean).length;
  return (words * 60) / WORDS_PER_MINUTE + (segment.blockIndex < 0 ? 0.6 : 0.25);
}

/** Running totals of estimated time: entry i is the time before segment i; the last is the total. */
export function cumulativeSeconds(segments: readonly ReadAloudSegment[]): number[] {
  const out = [0];
  for (const s of segments) out.push(out[out.length - 1]! + estimateSeconds(s));
  return out;
}

/** "4:05", or "1:02:09" past an hour. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "3 h 10 min", "12 min", "under a minute". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The segment in [start, end) that's playing `seconds` into the queue
 *  (as given by cumulativeSeconds), clamped to that range. */
export function segmentAtTime(times: readonly number[], start: number, end: number, seconds: number): number {
  let index = start;
  for (let i = start; i < end; i++) {
    if ((times[i] ?? Infinity) <= seconds) index = i;
    else break;
  }
  return index;
}
