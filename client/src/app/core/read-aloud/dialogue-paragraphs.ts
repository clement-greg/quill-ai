import { blockRange, collectContentBlocks } from '@app/features/chapters/chapter-edit/chapter-content-blocks';
import { dialogueKey, dialogueSpans, DialogueSpan } from '@shared/models/dialogue.model';

/** One paragraph of a chapter (in parseContentBlocks() order) with its dialogue. */
export interface DialogueBlock {
  text: string;
  /** Quotes and italic thoughts; empty for pure narration. */
  spans: DialogueSpan[];
  /** dialogueKey(text, spans); only set when there are spans. */
  key?: string;
}

/**
 * A chapter's paragraphs with their dialogue spans. Uses the same paragraph
 * split and text as parseContentBlocks(), so block i here is paragraph i in
 * the read-aloud queue, and the keys match between saving and playback.
 */
export function dialogueBlocks(html: string): DialogueBlock[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  return collectContentBlocks(root).map(block => {
    const range = blockRange(root, block.anchor);
    const italics = range ? italicRanges(range, block.text) : [];
    const spans = dialogueSpans(block.text, italics);
    return spans.length ? { text: block.text, spans, key: dialogueKey(block.text, spans) } : { text: block.text, spans };
  });
}

/** Italic runs in the block, as offsets into its normalized text (the block's
 *  `text`); empty if the walk doesn't reproduce that text exactly. */
function italicRanges(range: Range, expected: string): DialogueSpan[] {
  const chars: string[] = [];
  const flags: boolean[] = [];
  const walk = (node: Node, italic: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const c of node.textContent ?? '') { chars.push(c); flags.push(italic); }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const inner = italic || el.tagName === 'EM' || el.tagName === 'I' || el.style?.fontStyle === 'italic';
    el.childNodes.forEach(child => walk(child, inner));
  };
  range.cloneContents().childNodes.forEach(node => walk(node, false));

  // Same normalization as the block's text: collapse whitespace, trim.
  let text = '';
  const italic: boolean[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (/\s/.test(c)) {
      if (!text || text.endsWith(' ')) continue;
      text += ' ';
    } else {
      text += c;
    }
    italic.push(flags[i]!);
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); italic.pop(); }
  if (text !== expected) return [];

  const out: DialogueSpan[] = [];
  let start = -1;
  for (let i = 0; i <= italic.length; i++) {
    if (italic[i] && start < 0) start = i;
    else if (!italic[i] && start >= 0) { out.push({ start, end: i }); start = -1; }
  }
  return out;
}
