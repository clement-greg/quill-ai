/** Utilities for treating a chapter's HTML content as a flat list of visual
 *  paragraphs ("blocks"), regardless of how the markup is actually nested.
 *
 *  Real chapter content is often pasted-in HTML: bare top-level text nodes,
 *  wrapper <div>s holding dozens of paragraph <div>s, inline runs of
 *  <span>/text separated by <div><br></div> spacers, etc. The move-text
 *  dialog uses parseContentBlocks() to list paragraphs, and the chapter
 *  editor uses insertHtmlAtAnchor() with the block's node-path anchor so both
 *  sides agree on positions no matter the nesting. */

export interface BlockAnchor {
  /** childNode-index path from the content root to the block's first node. */
  startPath: number[];
  /** childNode-index path to the block's last node (differs from startPath
   *  when the block is a run of inline nodes rather than one element). */
  endPath: number[];
}

export interface ContentBlock {
  anchor: BlockAnchor;
  /** Normalized plain text of the block (non-empty). */
  text: string;
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE']);
const BLOCK_SELECTOR = 'p, div, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, pre';

/** Flattens the content's visual paragraphs. A block element that contains
 *  other block elements is treated as a wrapper and descended into;
 *  consecutive inline/text siblings are grouped into a single block. */
export function parseContentBlocks(content: string): ContentBlock[] {
  const container = document.createElement('div');
  container.innerHTML = content;
  const blocks: ContentBlock[] = [];
  collectBlocks(container, [], blocks);
  return blocks.filter(b => b.text.length > 0);
}

function collectBlocks(parent: Node, path: number[], out: ContentBlock[]): void {
  const nodes = Array.from(parent.childNodes);
  let runStart = -1;
  let runText = '';
  const flushRun = (endIndex: number): void => {
    if (runStart < 0) return;
    out.push({
      anchor: { startPath: [...path, runStart], endPath: [...path, endIndex] },
      text: normalizeText(runText),
    });
    runStart = -1;
    runText = '';
  };

  nodes.forEach((node, i) => {
    const isBlockEl = node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName);
    if (!isBlockEl) {
      if (runStart < 0) runStart = i;
      runText += node.textContent ?? '';
      return;
    }
    flushRun(i - 1);
    const el = node as Element;
    if (el.querySelector(BLOCK_SELECTOR)) {
      collectBlocks(el, [...path, i], out);
    } else {
      out.push({
        anchor: { startPath: [...path, i], endPath: [...path, i] },
        text: normalizeText(el.textContent ?? ''),
      });
    }
  });
  flushRun(nodes.length - 1);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Inserts html into content before/after the anchored block. A null anchor
 *  (or one that no longer resolves) appends at the end of the content. */
export function insertHtmlAtAnchor(
  content: string,
  html: string,
  anchor: BlockAnchor | null,
  position: 'before' | 'after',
): string {
  const container = document.createElement('div');
  container.innerHTML = content;
  const frag = document.createRange().createContextualFragment(html);
  const target = anchor
    ? resolvePath(container, position === 'before' ? anchor.startPath : anchor.endPath)
    : null;
  if (!target?.parentNode) {
    container.appendChild(frag);
  } else if (position === 'before') {
    target.parentNode.insertBefore(frag, target);
  } else {
    target.parentNode.insertBefore(frag, target.nextSibling);
  }
  return container.innerHTML;
}

function resolvePath(root: Node, path: number[]): Node | null {
  if (path.length === 0) return null;
  let node: Node | null = root;
  for (const index of path) {
    node = node?.childNodes[index] ?? null;
    if (!node) return null;
  }
  return node;
}
