/**
 * Book-wide find. Unmounted chapters have no editor DOM, so matches are
 * counted from each chapter's stored HTML using the same rules as the
 * editor's own find (case-insensitive, non-overlapping, within one text run),
 * so "match 7 of 40" lands on the same word the editor highlights.
 */

/** Text runs (text nodes, in document order) of an HTML fragment. */
export function textRunsOf(html: string): string[] {
  if (!html) return [];
  const template = document.createElement('template');
  template.innerHTML = html;
  const runs: string[] = [];
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n as Text).data;
    if (text) runs.push(text);
  }
  return runs;
}

/** Non-overlapping, case-insensitive matches of `query` across `runs`. */
export function countMatches(runs: readonly string[], query: string): number {
  if (!query.trim()) return 0;
  const needle = query.toLowerCase();
  let count = 0;
  for (const run of runs) {
    const hay = run.toLowerCase();
    let i = hay.indexOf(needle);
    while (i !== -1) {
      count++;
      i = hay.indexOf(needle, i + needle.length);
    }
  }
  return count;
}

/** Maps a book-wide match index to the chapter holding it and the index within
 *  that chapter. Returns null when there are no matches. */
export function locateMatch(counts: readonly number[], global: number): { chapter: number; local: number } | null {
  let remaining = global;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (remaining < c) return { chapter: i, local: remaining };
    remaining -= c;
  }
  return null;
}

/** Book-wide index of the first match in chapter `chapter` or after it,
 *  wrapping to the first match in the book. */
export function firstMatchFrom(counts: readonly number[], chapter: number): number {
  let before = 0;
  for (let i = 0; i < counts.length; i++) {
    if (i >= chapter && counts[i]! > 0) return before;
    before += counts[i]!;
  }
  return 0;
}

/** Caches text runs per chapter so each keystroke in the find box only
 *  re-parses chapters whose HTML changed. */
export class BookTextIndex {
  private cache = new Map<string, { html: string; runs: string[] }>();

  runsFor(id: string, html: string): string[] {
    const hit = this.cache.get(id);
    if (hit && hit.html === html) return hit.runs;
    const runs = textRunsOf(html);
    this.cache.set(id, { html, runs });
    return runs;
  }

  clear(): void {
    this.cache.clear();
  }
}
