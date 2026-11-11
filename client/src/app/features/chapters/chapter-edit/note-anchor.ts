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

/**
 * Wraps the anchored paragraph of `root` (the editor's content element) in a
 * note-indicator span for `noteId`, like a note made on a selection. The span
 * goes inside the paragraph's element (or its first list item), so the
 * paragraph markup stays valid. Returns the wrapped text, or null if the
 * paragraph can't be found.
 */
export function wrapAnchoredBlock(root: HTMLElement, noteId: string, anchor: ChapterNoteAnchor): string | null {
  const blocks = collectContentBlocks(root);
  const index = findAnchoredBlock(blocks.map(b => b.text), anchor);
  const block = blocks[index];
  if (!block) return null;
  const range = blockRange(root, block.anchor);
  if (!range) return null;

  const first = range.startContainer.childNodes[range.startOffset];
  const last = range.endContainer.childNodes[range.endOffset - 1];
  if (first && first === last && first.nodeType === Node.ELEMENT_NODE) {
    const el = first as Element;
    const inner = el.tagName === 'UL' || el.tagName === 'OL' ? el.querySelector('li') ?? el : el;
    range.selectNodeContents(inner);
  }

  const doc = root.ownerDocument;
  const span = doc.createElement('span');
  span.className = 'note-indicator';
  span.setAttribute('data-note-id', noteId);
  const text = range.toString();
  try {
    range.surroundContents(span);
  } catch {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  return normalize(text);
}
