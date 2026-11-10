/**
 * Page geometry and the pure page-break calculation for the full-book editor.
 *
 * Pages are US Letter (8.5in × 11in) with 0.75in margins at the CSS reference
 * resolution of 96px per inch, so the on-screen page is the printed page at
 * 100% zoom. Everything here is plain arithmetic over measured line boxes, so
 * it is unit-testable without a layout engine; the DOM side lives in
 * book-paginator.ts.
 */

export const PX_PER_INCH = 96;
export const PAGE_WIDTH = 8.5 * PX_PER_INCH; // 816
export const PAGE_HEIGHT = 11 * PX_PER_INCH; // 1056
export const PAGE_MARGIN = 0.75 * PX_PER_INCH; // 72
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN; // 672
export const CONTENT_HEIGHT = PAGE_HEIGHT - 2 * PAGE_MARGIN; // 912
/** Visual gap between consecutive page sheets. */
export const PAGE_GAP = 24;
/** Distance from the top of one page to the top of the next. */
export const PAGE_STRIDE = PAGE_HEIGHT + PAGE_GAP;

/** Half a pixel of slack so sub-pixel rounding never pushes a fitting line. */
const FIT_TOLERANCE = 0.5;

/** One laid-out line, in px from the top of its chapter section, measured with
 *  no page spacers in the flow. */
export interface LineBox {
  top: number;
  bottom: number;
  /** Identifies the paragraph (block) the line belongs to. */
  block: number;
}

/** A page break: insert a spacer of `height` px immediately before line `line`. */
export interface PageBreak {
  line: number;
  height: number;
}

export interface PageLayout {
  breaks: PageBreak[];
  pageCount: number;
}

/** Top of page `page`'s text area, from the top of the chapter section. */
export function pageContentTop(page: number): number {
  return page * PAGE_STRIDE + PAGE_MARGIN;
}

/** Bottom of page `page`'s text area. */
export function pageContentBottom(page: number): number {
  return pageContentTop(page) + CONTENT_HEIGHT;
}

/** Height of a chapter section holding the given number of pages (no trailing gap). */
export function sectionHeight(pages: number): number {
  const n = Math.max(1, pages);
  return n * PAGE_HEIGHT + (n - 1) * PAGE_GAP;
}

/**
 * Decides where pages break. Lines are flowed top to bottom; the first line
 * whose box would cross the bottom of the current page's text area starts the
 * next page, with a spacer sized to land it exactly on that page's top margin.
 *
 * Widow/orphan control (the word-processor default) keeps at least two lines
 * of a paragraph together on each side of a break: a paragraph's lone first
 * line is carried to the next page (orphan), and a paragraph's lone last line
 * pulls one line over with it (widow). Neither rule fires when it would leave
 * the page empty, and a single line taller than a page simply overflows.
 *
 * `lines` must be in document order with no spacers in the flow.
 */
export function computePageBreaks(lines: readonly LineBox[], widowOrphanControl = true): PageLayout {
  const breaks: PageBreak[] = [];
  let shift = 0; // total spacer height inserted so far
  let page = 0;
  let pageFirstLine = 0; // first line placed on the current page

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.bottom + shift <= pageContentBottom(page) + FIT_TOLERANCE) continue;
    if (i === pageFirstLine) {
      // A line that can't fit even on an empty page: let it overflow, then
      // carry on from whichever page its bottom ended up on.
      page = Math.max(page, pageAt(line.bottom + shift));
      pageFirstLine = i + 1;
      continue;
    }

    let breakAt = i;
    if (widowOrphanControl) breakAt = adjustForWidowsAndOrphans(lines, i, pageFirstLine);

    const target = pageContentTop(page + 1);
    const height = target - (lines[breakAt]!.top + shift);
    breaks.push({ line: breakAt, height });
    shift += height;
    page++;
    pageFirstLine = breakAt;
    i = breakAt; // re-check the moved line(s) against the new page
  }

  const last = lines[lines.length - 1];
  const pageCount = last ? Math.max(page, pageAt(last.bottom + shift)) + 1 : 1;
  return { breaks, pageCount };
}

/** Index of the page a y-coordinate falls on (gaps count toward the page above). */
function pageAt(y: number): number {
  return Math.max(0, Math.floor((y - FIT_TOLERANCE) / PAGE_STRIDE));
}

function adjustForWidowsAndOrphans(lines: readonly LineBox[], i: number, pageFirstLine: number): number {
  const block = lines[i]!.block;
  const prevSame = i > 0 && lines[i - 1]!.block === block;
  if (!prevSame) return i; // clean break between paragraphs

  // Orphan: only the paragraph's first line would stay behind.
  const prevIsFirst = i - 1 === 0 || lines[i - 2]!.block !== block;
  if (prevIsFirst && i - 1 > pageFirstLine) return i - 1;

  // Widow: only the paragraph's last line would go over.
  const isLast = i === lines.length - 1 || lines[i + 1]!.block !== block;
  if (isLast && !prevIsFirst && i - 1 > pageFirstLine) return i - 1;

  return i;
}

/** First page index of every chapter, plus the total, from per-chapter page counts. */
export function pageOffsets(pageCounts: readonly number[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let total = 0;
  for (const n of pageCounts) {
    starts.push(total);
    total += Math.max(1, n);
  }
  return { starts, total };
}

/**
 * Rough page count for a chapter that hasn't been laid out yet, from its text
 * length. `charsPerPage` is calibrated from chapters that have been measured
 * (see BookEditor), so the estimate tracks the author's font size.
 */
export function estimatePageCount(textLength: number, charsPerPage: number): number {
  if (charsPerPage <= 0) return 1;
  return Math.max(1, Math.ceil(textLength / charsPerPage));
}

/** Index of the item whose [start, start + size) range contains `y` (binary search
 *  over ascending `starts`); clamps to the first/last item. */
export function indexAt(starts: readonly number[], y: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
