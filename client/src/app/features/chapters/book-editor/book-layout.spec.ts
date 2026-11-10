import { describe, it, expect } from 'vitest';
import {
  computePageBreaks, estimatePageCount, indexAt, LineBox, pageContentBottom, pageContentTop,
  pageOffsets, sectionHeight, CONTENT_HEIGHT, PAGE_GAP, PAGE_HEIGHT, PAGE_MARGIN, PAGE_STRIDE,
} from './book-layout';

const LH = 28;

/** Builds consecutive lines starting at the first page's top margin.
 *  `blocks` lists how many lines each paragraph has. */
function flow(blocks: number[], start = PAGE_MARGIN): LineBox[] {
  const lines: LineBox[] = [];
  let y = start;
  blocks.forEach((count, block) => {
    for (let i = 0; i < count; i++) {
      lines.push({ top: y, bottom: y + LH, block });
      y += LH;
    }
  });
  return lines;
}

const LINES_PER_PAGE = Math.floor(CONTENT_HEIGHT / LH); // 32

describe('book-layout geometry', () => {
  it('uses US Letter at 96 dpi with 0.75in margins', () => {
    expect(PAGE_HEIGHT).toBe(1056);
    expect(PAGE_MARGIN).toBe(72);
    expect(CONTENT_HEIGHT).toBe(912);
    expect(pageContentTop(1)).toBe(PAGE_STRIDE + 72);
    expect(pageContentBottom(0)).toBe(984);
  });

  it('sizes a section by its pages with gaps only between them', () => {
    expect(sectionHeight(1)).toBe(PAGE_HEIGHT);
    expect(sectionHeight(3)).toBe(3 * PAGE_HEIGHT + 2 * PAGE_GAP);
    expect(sectionHeight(0)).toBe(PAGE_HEIGHT);
  });
});

describe('computePageBreaks', () => {
  it('returns one page and no breaks for empty or short content', () => {
    expect(computePageBreaks([])).toEqual({ breaks: [], pageCount: 1 });
    expect(computePageBreaks(flow([5]))).toEqual({ breaks: [], pageCount: 1 });
  });

  it('breaks between paragraphs exactly at the page boundary', () => {
    const lines = flow([LINES_PER_PAGE, 3]);
    const { breaks, pageCount } = computePageBreaks(lines);
    expect(pageCount).toBe(2);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.line).toBe(LINES_PER_PAGE);
    // Spacer lands the next line on page 2's top margin.
    expect(lines[LINES_PER_PAGE]!.top + breaks[0]!.height).toBe(pageContentTop(1));
  });

  it('splits a long paragraph mid-paragraph at the line that does not fit', () => {
    const lines = flow([LINES_PER_PAGE + 10]);
    const { breaks } = computePageBreaks(lines);
    expect(breaks[0]!.line).toBe(LINES_PER_PAGE);
  });

  it('carries an orphaned first line to the next page', () => {
    // Paragraph 1 fills all but one line; paragraph 2 would leave its first line behind.
    const lines = flow([LINES_PER_PAGE - 1, 5]);
    const { breaks } = computePageBreaks(lines);
    expect(breaks[0]!.line).toBe(LINES_PER_PAGE - 1); // the whole of paragraph 2 moves
  });

  it('pulls a line over so a paragraph\'s last line is not widowed', () => {
    // Paragraph of LINES_PER_PAGE + 1 lines: only its last line would go over.
    const lines = flow([LINES_PER_PAGE + 1]);
    const { breaks } = computePageBreaks(lines);
    expect(breaks[0]!.line).toBe(LINES_PER_PAGE - 1);
  });

  it('can turn widow/orphan control off', () => {
    const lines = flow([LINES_PER_PAGE + 1]);
    expect(computePageBreaks(lines, false).breaks[0]!.line).toBe(LINES_PER_PAGE);
  });

  it('accumulates spacer shift across many pages', () => {
    const lines = flow([LINES_PER_PAGE * 5]);
    const { breaks, pageCount } = computePageBreaks(lines, false);
    expect(pageCount).toBe(5);
    expect(breaks).toHaveLength(4);
    let shift = 0;
    breaks.forEach((b, i) => {
      shift += b.height;
      expect(lines[b.line]!.top + shift).toBe(pageContentTop(i + 1));
    });
  });

  it('lets a line taller than a page overflow instead of looping', () => {
    const lines: LineBox[] = [
      { top: PAGE_MARGIN, bottom: PAGE_MARGIN + 2000, block: 0 },
      { top: PAGE_MARGIN + 2000, bottom: PAGE_MARGIN + 2028, block: 1 },
    ];
    const { pageCount } = computePageBreaks(lines);
    expect(pageCount).toBeGreaterThanOrEqual(2);
  });

  it('honours content that starts lower on page 1 (e.g. under the chapter title)', () => {
    const lines = flow([LINES_PER_PAGE], PAGE_MARGIN + 100);
    const { breaks } = computePageBreaks(lines, false);
    expect(breaks).toHaveLength(1);
    expect(lines[breaks[0]!.line]!.bottom).toBeGreaterThan(pageContentBottom(0));
    expect(lines[breaks[0]!.line - 1]!.bottom).toBeLessThanOrEqual(pageContentBottom(0));
  });
});

describe('page bookkeeping helpers', () => {
  it('computes chapter start pages and the total', () => {
    expect(pageOffsets([3, 1, 0, 5])).toEqual({ starts: [0, 3, 4, 5], total: 10 });
  });

  it('estimates pages from text length', () => {
    expect(estimatePageCount(0, 2000)).toBe(1);
    expect(estimatePageCount(4001, 2000)).toBe(3);
    expect(estimatePageCount(100, 0)).toBe(1);
  });

  it('finds the containing range by binary search', () => {
    const starts = [0, 100, 250, 900];
    expect(indexAt(starts, -5)).toBe(0);
    expect(indexAt(starts, 0)).toBe(0);
    expect(indexAt(starts, 99)).toBe(0);
    expect(indexAt(starts, 100)).toBe(1);
    expect(indexAt(starts, 899)).toBe(2);
    expect(indexAt(starts, 5000)).toBe(3);
    expect(indexAt([], 10)).toBe(-1);
  });
});
