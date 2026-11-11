import { ChapterNoteAnchor } from '@shared/models/chapter.model';
import { blockRange, collectContentBlocks } from './chapter-content-blocks';

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Which paragraph an anchored note belongs to, given the chapter's paragraphs
 * in parseContentBlocks() order; -1 when it can't be placed.
 *
 * The paragraph's text wins over its index, since the chapter may have been
 * edited since the note was added: the matching paragraph nearest the old
 * index is used. When no paragraph matches (it was rewritten), or no text was
 * recorded, the old index is used if it still exists.
 */
export function findAnchoredBlock(texts: readonly string[], anchor: ChapterNoteAnchor): number {
  const key = normalize(anchor.text ?? '');
  if (key) {
    let best = -1;
    texts.forEach((text, i) => {
      const t = normalize(text);
      // The recorded text may be cut short, so a paragraph that starts with it matches.
      if (!t || !(t.startsWith(key) || key.startsWith(t))) return;
      if (best < 0 || Math.abs(i - anchor.blockIndex) < Math.abs(best - anchor.blockIndex)) best = i;
    });
    if (best >= 0) return best;
  }
  return anchor.blockIndex >= 0 && anchor.blockIndex < texts.length ? anchor.blockIndex : -1;
}

/** A word: letters or digits, with inner apostrophes and hyphens. */
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}\u2019'-]*[\p{L}\p{N}])?/gu;

/**
 * The [start, end) of the word to pin a note to within a paragraph's text:
 * the recorded word at its offset, or the same word nearest that offset if
 * the paragraph has changed; failing that (or with no word recorded), the
 * paragraph's last word. Null when the paragraph has no words.
 */
export function findAnchoredWord(text: string, anchor: ChapterNoteAnchor): [number, number] | null {
  const words = [...text.matchAll(WORD)].map(m => [m.index!, m.index! + m[0].length] as [number, number]);
  if (!words.length) return null;
  const { word, wordOffset } = anchor;
  if (word && wordOffset !== undefined) {
    const exact = words.find(([start, end]) => start === wordOffset && text.slice(start, end) === word);
    if (exact) return exact;
    const same = words.filter(([start, end]) => text.slice(start, end).toLowerCase() === word.toLowerCase());
    if (same.length) {
      return same.reduce((best, w) => (Math.abs(w[0] - wordOffset) < Math.abs(best[0] - wordOffset) ? w : best));
    }
  }
  return words.at(-1)!;
}

/**
 * Wraps the anchored word of `root` (the editor's content element) in a
 * note-indicator span for `noteId`, like a note made on a selection: the word
 * being read when the note was added, else the paragraph's last word, else (a
 * paragraph with no words) the whole paragraph. Returns the wrapped text, or
 * null if the paragraph can't be found.
 */
export function wrapAnchoredBlock(root: HTMLElement, noteId: string, anchor: ChapterNoteAnchor): string | null {
  const blocks = collectContentBlocks(root);
  const index = findAnchoredBlock(blocks.map(b => b.text), anchor);
  const block = blocks[index];
  if (!block) return null;
  const range = blockRange(root, block.anchor);
  if (!range) return null;

  const span = word(range, block.text, anchor) ?? paragraphContents(range);
  const text = span.toString();
  const el = root.ownerDocument.createElement('span');
  el.className = 'note-indicator';
  el.setAttribute('data-note-id', noteId);
  try {
    span.surroundContents(el);
  } catch {
    el.appendChild(span.extractContents());
    span.insertNode(el);
  }
  return normalize(text);
}

/** A range over the anchored word, mapped from the paragraph's normalized
 *  text (whitespace collapsed, trimmed) back to the text nodes it came from. */
function word(block: Range, text: string, anchor: ChapterNoteAnchor): Range | null {
  const target = findAnchoredWord(text, anchor);
  if (!target) return null;
  // positions[i] is the text node and offset of the i-th normalized character.
  const positions: [Text, number][] = [];
  let pendingSpace: [Text, number] | null = null;
  const doc = block.startContainer.ownerDocument ?? document;
  const walker = doc.createTreeWalker(block.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!block.intersectsNode(node)) continue;
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i]!)) {
        if (positions.length) pendingSpace ??= [node, i];
        continue;
      }
      if (pendingSpace) { positions.push(pendingSpace); pendingSpace = null; }
      positions.push([node, i]);
    }
  }
  const [start, end] = target;
  const first = positions[start];
  const last = positions[end - 1];
  if (!first || !last) return null;
  // A "word" running across list items or other blocks can't be wrapped validly.
  if (blockOf(first[0]) !== blockOf(last[0])) return null;
  const range = doc.createRange();
  range.setStart(first[0], first[1]);
  range.setEnd(last[0], last[1] + 1);
  return range;
}

const INNER_BLOCKS = 'li, p, div, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th';

function blockOf(node: Text): Element | null {
  return node.parentElement?.closest(INNER_BLOCKS) ?? null;
}

/** The inside of the paragraph's element (or its first list item), so the
 *  paragraph markup stays valid; the range itself for a run of loose inline content. */
function paragraphContents(range: Range): Range {
  const first = range.startContainer.childNodes[range.startOffset];
  const last = range.endContainer.childNodes[range.endOffset - 1];
  if (first && first === last && first.nodeType === Node.ELEMENT_NODE) {
    const el = first as Element;
    const inner = el.tagName === 'UL' || el.tagName === 'OL' ? el.querySelector('li') ?? el : el;
    range.selectNodeContents(inner);
  }
  return range;
}
