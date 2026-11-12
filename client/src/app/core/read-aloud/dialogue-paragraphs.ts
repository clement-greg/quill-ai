import { BlockAnchor, collectContentBlocks } from '@app/features/chapters/chapter-edit/chapter-content-blocks';
import { dialogueKey, dialogueSpans, DialogueSpan } from '@shared/models/dialogue.model';

/** One paragraph of a chapter (in parseContentBlocks() order) with its dialogue. */
export interface DialogueBlock {
  text: string;
  /** Quotes and italic thoughts; empty for pure narration. */
  spans: DialogueSpan[];
  /** dialogueKey(text, spans); only set when there are spans. */
  key?: string;
}

/** A line of dialogue in a live editor, with the DOM range it covers. */
export interface LiveDialogue {
  key: string;
  /** Which of the paragraph's spans (index into its speakers). */
  index: number;
  /** The paragraph's index in parseContentBlocks() order. */
  blockIndex: number;
  text: string;
  range: Range;
}

/**
 * A chapter's paragraphs with their dialogue spans. Uses the same paragraph
 * split and text as parseContentBlocks(), so block i here is paragraph i in
 * the read-aloud queue, and the keys match between saving and playback.
 */
export function dialogueBlocks(html: string): DialogueBlock[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  return scanBlocks(root).map(({ text, spans, key }) => (key ? { text, spans, key } : { text, spans }));
}

/** Every line of dialogue in a live element (e.g. the chapter editor), keyed
 *  exactly as dialogueBlocks() keys the saved HTML. */
export function liveDialogue(root: Node): LiveDialogue[] {
  const doc = root.ownerDocument ?? document;
  const out: LiveDialogue[] = [];
  scanBlocks(root).forEach((block, blockIndex) => {
    if (!block.key) return;
    block.spans.forEach((span, index) => {
      const start = block.positions[span.start];
      const end = block.positions[span.end - 1];
      if (!start || !end) return;
      const range = doc.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      out.push({ key: block.key!, index, blockIndex, text: block.text.slice(span.start, span.end), range });
    });
  });
  return out;
}

interface CharPosition {
  node: Text;
  offset: number;
}

interface ScannedBlock extends DialogueBlock {
  /** Where each character of `text` is in the DOM. */
  positions: CharPosition[];
}

function scanBlocks(root: Node): ScannedBlock[] {
  return collectContentBlocks(root).map(block => {
    const scanned = scanBlock(root, block.anchor);
    // Fall back to no italics if the walk somehow disagrees with the block's text.
    const ok = scanned.text === block.text;
    const spans = dialogueSpans(block.text, ok ? scanned.italics : []);
    // Without positions, liveDialogue() just can't place this block's spans.
    const positions = ok ? scanned.positions : [];
    return spans.length
      ? { text: block.text, spans, key: dialogueKey(block.text, spans), positions }
      : { text: block.text, spans, positions };
  });
}

/** The block's normalized text (whitespace collapsed, trimmed — as
 *  parseContentBlocks() makes it), its italic runs, and each character's place in the DOM. */
function scanBlock(root: Node, anchor: BlockAnchor): { text: string; italics: DialogueSpan[]; positions: CharPosition[] } {
  const raw: { c: string; italic: boolean; node: Text; offset: number }[] = [];
  const walk = (node: Node, italic: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const data = text.data;
      for (let i = 0; i < data.length; i++) raw.push({ c: data[i]!, italic, node: text, offset: i });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const inner = italic || el.tagName === 'EM' || el.tagName === 'I' || el.style?.fontStyle === 'italic';
    el.childNodes.forEach(child => walk(child, inner));
  };
  for (const node of blockNodes(root, anchor)) walk(node, false);

  let text = '';
  const italic: boolean[] = [];
  const positions: CharPosition[] = [];
  for (const r of raw) {
    if (/\s/.test(r.c)) {
      if (!text || text.endsWith(' ')) continue;
      text += ' ';
    } else {
      text += r.c;
    }
    italic.push(r.italic);
    positions.push({ node: r.node, offset: r.offset });
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); italic.pop(); positions.pop(); }

  const italics: DialogueSpan[] = [];
  let start = -1;
  for (let i = 0; i <= italic.length; i++) {
    if (italic[i] && start < 0) start = i;
    else if (!italic[i] && start >= 0) { italics.push({ start, end: i }); start = -1; }
  }
  return { text, italics, positions };
}

/** The sibling nodes a block anchor spans, from its first node to its last. */
function blockNodes(root: Node, anchor: BlockAnchor): Node[] {
  const start = resolve(root, anchor.startPath);
  const end = resolve(root, anchor.endPath);
  if (!start || !end) return [];
  const nodes: Node[] = [];
  for (let n: Node | null = start; n; n = n.nextSibling) {
    nodes.push(n);
    if (n === end) return nodes;
  }
  return [start];
}

function resolve(root: Node, path: readonly number[]): Node | null {
  if (!path.length) return null;
  let node: Node | null = root;
  for (const i of path) node = node?.childNodes[i] ?? null;
  return node;
}
