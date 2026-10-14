/** Block-level elements that can carry a data-ai-generated mark (whole
 *  paragraphs from "Replace chapter" with an AI draft). */
export const AI_BLOCK_SELECTOR = 'p[data-ai-generated]';

/** Removes the data-ai-generated mark from any of the given AI-marked blocks
 *  that hold no text — e.g. the empty paragraph the browser creates (copying the
 *  mark) when Enter is pressed at either end of an AI paragraph. Returns true
 *  when anything changed. */
export function clearAiMarkOnEmptyBlocks(blocks: readonly (Element | null)[]): boolean {
  let changed = false;
  for (const block of new Set(blocks)) {
    if (!block?.matches(AI_BLOCK_SELECTOR)) continue;
    if ((block.textContent ?? '').replace(/[\s​]/g, '') !== '') continue;
    block.removeAttribute('data-ai-generated');
    changed = true;
  }
  return changed;
}
