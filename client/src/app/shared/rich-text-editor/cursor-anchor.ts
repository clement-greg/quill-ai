/** Block-level elements a saved cursor position is anchored to. */
const CURSOR_BLOCK_SELECTOR = 'div, p, li, blockquote, h1, h2, h3, h4, h5, h6';

/** One end of a saved selection: the block holding it and its character
 *  offset within that block's text. */
interface CursorPoint { block: HTMLElement; offset: number }

export interface SavedCursor { start: CursorPoint; end: CursorPoint }

/** Captures the selection inside `editor` so it survives rewrapping of inline
 *  text (grammar marks added or removed, text nodes merged). Each end is stored
 *  relative to its paragraph rather than the whole editor, so a caret in an
 *  empty paragraph — which has no text node to count from — comes back to that
 *  paragraph instead of the end of the previous one. */
export function saveCursor(editor: HTMLElement): SavedCursor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return null;
  const point = (node: Node, offset: number): CursorPoint => {
    const block = blockOf(editor, node);
    const before = document.createRange();
    before.setStart(block, 0);
    before.setEnd(node, offset);
    return { block, offset: before.toString().length };
  };
  return { start: point(range.startContainer, range.startOffset), end: point(range.endContainer, range.endOffset) };
}

/** Puts back a selection captured by `saveCursor`. No-op when its paragraph
 *  is gone from the editor. */
export function restoreCursor(editor: HTMLElement, saved: SavedCursor | null): void {
  if (!saved) return;
  const start = locate(editor, saved.start);
  if (!start) return;
  const collapsed = saved.start.block === saved.end.block && saved.start.offset === saved.end.offset;
  const end = collapsed ? start : (locate(editor, saved.end) ?? start);
  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  } catch { /* ignore if nodes shifted */ }
}

function blockOf(editor: HTMLElement, node: Node): HTMLElement {
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const block = el?.closest<HTMLElement>(CURSOR_BLOCK_SELECTOR);
  return block && block !== editor && editor.contains(block) ? block : editor;
}

function locate(editor: HTMLElement, point: CursorPoint): { node: Node; offset: number } | null {
  if (point.block !== editor && !editor.contains(point.block)) return null;
  let chars = 0;
  let last: Text | null = null;
  const walker = document.createTreeWalker(point.block, NodeFilter.SHOW_TEXT);
  let n: Text | null;
  while ((n = walker.nextNode() as Text | null)) {
    if (chars + n.length >= point.offset) return { node: n, offset: point.offset - chars };
    chars += n.length;
    last = n;
  }
  // No text to land in (an empty paragraph) or the text got shorter: put the
  // caret at the end of what the block holds.
  return last ? { node: last, offset: last.length } : { node: point.block, offset: 0 };
}
