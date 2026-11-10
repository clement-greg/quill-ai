import { computePageBreaks, LineBox, PageLayout } from './book-layout';

/**
 * DOM side of full-book pagination.
 *
 * Page breaks are drawn by inserting an empty, non-editable block spacer at
 * the exact character where the first line of each new page starts. Because
 * the spacer goes in at a line's start, the text on either side wraps exactly
 * as before; only the vertical position changes. Spacers carry no text, are
 * stripped from saved HTML (cleanEditorHtml) and are rebuilt from scratch on
 * every layout pass, so they never affect the chapter's stored content.
 */

export const PAGE_SPACER_ATTR = 'data-page-spacer';
const SPACER_SELECTOR = `[${PAGE_SPACER_ATTR}]`;
const BLOCK_SELECTOR = 'div, p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, ul, ol';

/** Removes every page spacer under `root`, merging the text nodes they split.
 *  Range-preserving: live selections follow the DOM normalize() spec. */
export function removePageSpacers(root: HTMLElement): boolean {
  const spacers = root.querySelectorAll(SPACER_SELECTOR);
  if (spacers.length === 0) return false;
  const parents = new Set<Node>();
  spacers.forEach(s => {
    if (s.parentNode) parents.add(s.parentNode);
    s.remove();
  });
  parents.forEach(p => p.normalize());
  return true;
}

interface MeasuredLine extends LineBox {
  /** First text node (or atomic element) on the line, in document order. */
  node: Node;
  /** Viewport-space top of the node's fragment on this line (used to find the offset). */
  fragTop: number;
}

/**
 * Measures the line boxes of the flow inside `editor`, relative to `origin`'s
 * top edge. Lines are reconstructed from the per-line fragments of each text
 * node, widened to the full line-height of their paragraph so that page fit
 * is judged on the line box, not just the glyphs.
 */
export function measureLines(editor: HTMLElement, origin: HTMLElement): MeasuredLine[] {
  const originTop = origin.getBoundingClientRect().top;
  const lineHeights = new Map<Element, number>();
  const blockIds = new Map<Element, number>();
  const lines: MeasuredLine[] = [];
  const range = document.createRange();

  const lineHeightOf = (el: Element): number => {
    let lh = lineHeights.get(el);
    if (lh === undefined) {
      const cs = getComputedStyle(el);
      lh = parseFloat(cs.lineHeight);
      if (!Number.isFinite(lh)) lh = parseFloat(cs.fontSize) * 1.2;
      lineHeights.set(el, lh);
    }
    return lh;
  };
  const blockOf = (node: Node): number => {
    const parent = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const block = parent?.closest(BLOCK_SELECTOR);
    const key = block && editor.contains(block) && block !== editor ? block : editor;
    let id = blockIds.get(key);
    if (id === undefined) { id = blockIds.size; blockIds.set(key, id); }
    // Loose text directly in the editor: treat each <br>-separated run as one
    // block-ish unit is overkill — the whole run shares the editor's id.
    return id;
  };

  const addFragment = (node: Node, rect: DOMRect, lh: number): void => {
    if (rect.height === 0 && rect.width === 0) return;
    const mid = (rect.top + rect.bottom) / 2 - originTop;
    const half = Math.max(lh, rect.height) / 2;
    const top = mid - half;
    const bottom = mid + half;
    const last = lines[lines.length - 1];
    // Same line when the fragment's middle sits inside the current line box.
    if (last && mid > last.top && mid < last.bottom) {
      last.top = Math.min(last.top, top);
      last.bottom = Math.max(last.bottom, bottom);
      return;
    }
    lines.push({ top, bottom, block: blockOf(node), node, fragTop: rect.top });
  };

  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => {
      if (n.nodeType === Node.TEXT_NODE) return (n as Text).data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      const el = n as Element;
      if (el.hasAttribute(PAGE_SPACER_ATTR)) return NodeFilter.FILTER_REJECT;
      return el.tagName === 'IMG' || el.tagName === 'HR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const lh = lineHeightOf(n.parentElement ?? editor);
      range.selectNodeContents(n);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) addFragment(n, rects[i]!, lh);
    } else {
      const rect = (n as Element).getBoundingClientRect();
      addFragment(n, rect, rect.height);
    }
  }
  range.detach();
  return lines;
}

/** Finds the character offset in `text` where the line whose fragment starts at
 *  viewport y `fragTop` begins (binary search over character rects). */
function lineStartOffset(text: Text, fragTop: number): number {
  const range = document.createRange();
  let lo = 0;
  let hi = text.data.length - 1;
  let found = text.data.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    range.setStart(text, mid);
    range.setEnd(text, mid + 1);
    const rects = range.getClientRects();
    const r = rects[rects.length - 1];
    // Whitespace that hangs at a line end reports the previous line; anything
    // on or below the target line counts as "at or after the line start".
    if (r && r.top >= fragTop - 1) { found = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  range.detach();
  return found;
}

function makeSpacer(height: number): HTMLElement {
  const spacer = document.createElement('span');
  spacer.setAttribute(PAGE_SPACER_ATTR, '');
  spacer.setAttribute('contenteditable', 'false');
  spacer.setAttribute('aria-hidden', 'true');
  spacer.className = 'page-spacer';
  spacer.style.height = `${height}px`;
  return spacer;
}

/** Inserts a spacer before the start of `line`. Text is split at the line
 *  start; when that is the very start of an inline element (an entity link,
 *  a note), the spacer goes before the element instead of inside it. */
function insertSpacerAt(editor: HTMLElement, line: MeasuredLine, height: number): void {
  const spacer = makeSpacer(height);
  let anchor: Node = line.node;
  if (anchor.nodeType === Node.TEXT_NODE) {
    const text = anchor as Text;
    const offset = lineStartOffset(text, line.fragTop);
    if (offset > 0 && offset < text.data.length) {
      const parentEl = text.parentElement;
      if (parentEl?.isContentEditable === false) {
        // Never split inside non-editable content; break before it.
        anchor = parentEl.closest('[contenteditable="false"]') ?? text;
      } else {
        anchor = text.splitText(offset);
      }
    }
  }
  // Hoist out of inline wrappers whose content begins at the anchor.
  while (
    anchor.parentNode && anchor.parentNode !== editor &&
    anchor.parentNode.firstChild === anchor &&
    !(anchor.parentNode as Element).matches?.(BLOCK_SELECTOR)
  ) {
    anchor = anchor.parentNode;
  }
  anchor.parentNode?.insertBefore(spacer, anchor);
}

/**
 * Lays out one chapter: clears old spacers, measures, decides breaks and
 * inserts the new spacers. All reads happen in one pass after a single
 * reflow, then all writes, so cost is one layout per call.
 *
 * `origin` is the chapter section (page 1's top edge); `editor` the flow.
 */
export function paginateChapter(editor: HTMLElement, origin: HTMLElement): PageLayout {
  removePageSpacers(editor);
  const lines = measureLines(editor, origin);
  const layout = computePageBreaks(lines);
  // Insert bottom-up so earlier insertions don't disturb later anchors.
  for (let i = layout.breaks.length - 1; i >= 0; i--) {
    const b = layout.breaks[i]!;
    insertSpacerAt(editor, lines[b.line]!, b.height);
  }
  return layout;
}

/** Measures without changing the DOM (for off-screen page counting). */
export function measureChapterPages(editor: HTMLElement, origin: HTMLElement): number {
  return computePageBreaks(measureLines(editor, origin)).pageCount;
}
