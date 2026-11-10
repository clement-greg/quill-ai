import { blockRange, collectContentBlocks } from '@app/features/chapters/chapter-edit/chapter-content-blocks';

/** CSS custom highlight name; styled by `::highlight(read-aloud)` in styles.css. */
export const READ_ALOUD_HIGHLIGHT = 'read-aloud';

interface HighlightRegistry { set(name: string, value: unknown): void; delete(name: string): void }
type HighlightCtor = new (...ranges: Range[]) => unknown;

function registry(): { highlights: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && Highlight ? { highlights: css.highlights, Highlight } : null;
}

/**
 * Finds the paragraph being read in a live editor element. Uses the paragraph
 * index first and falls back to matching its text, in case the chapter was
 * edited since the queue was built.
 */
export function findReadAloudRange(root: Node, blockIndex: number, text: string): Range | null {
  if (blockIndex < 0) return null;
  const blocks = collectContentBlocks(root);
  let block = blocks[blockIndex];
  if (!block || block.text !== text) {
    const matches = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.text === text);
    matches.sort((a, b) => Math.abs(a.i - blockIndex) - Math.abs(b.i - blockIndex));
    block = matches[0]?.b ?? block;
  }
  return block ? blockRange(root, block.anchor) : null;
}

/**
 * Shades the range with the CSS Custom Highlight API, which paints without
 * touching the DOM, so nothing can leak into saved chapter content.
 */
export function setReadAloudHighlight(range: Range | null): void {
  const reg = registry();
  if (!reg) return;
  if (range) reg.highlights.set(READ_ALOUD_HIGHLIGHT, new reg.Highlight(range));
  else reg.highlights.delete(READ_ALOUD_HIGHLIGHT);
}

/** Scrolls the range to the middle of the screen unless it's already comfortably in view. */
export function revealRange(range: Range, win: Window = window): void {
  const rect = range.getBoundingClientRect();
  const viewport = win.innerHeight;
  // Leave room for the app bar above and the player bar below.
  if (rect.height > 0 && rect.top >= 80 && rect.bottom <= viewport - 140) return;
  const node = range.startContainer.childNodes[range.startOffset] ?? range.startContainer;
  const el = node instanceof Element ? node : node.parentElement;
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
