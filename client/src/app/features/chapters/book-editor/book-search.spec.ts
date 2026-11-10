import { describe, it, expect } from 'vitest';
import { BookTextIndex, countMatches, firstMatchFrom, locateMatch, textRunsOf } from './book-search';

describe('book search', () => {
  it('splits HTML into text runs like the editor sees them', () => {
    const runs = textRunsOf('<p>The <span class="entity-reference">Keeper</span> watched.</p><p>Bell</p>');
    expect(runs).toEqual(['The ', 'Keeper', ' watched.', 'Bell']);
    expect(textRunsOf('')).toEqual([]);
  });

  it('counts case-insensitive, non-overlapping matches within runs', () => {
    expect(countMatches(['The bell, THE Bell'], 'bell')).toBe(2);
    expect(countMatches(['aaaa'], 'aa')).toBe(2);
    expect(countMatches(['bel', 'l'], 'bell')).toBe(0); // never across runs, same as the editor
    expect(countMatches(['anything'], '   ')).toBe(0);
  });

  it('locates a book-wide match in its chapter', () => {
    const counts = [2, 0, 3];
    expect(locateMatch(counts, 0)).toEqual({ chapter: 0, local: 0 });
    expect(locateMatch(counts, 1)).toEqual({ chapter: 0, local: 1 });
    expect(locateMatch(counts, 2)).toEqual({ chapter: 2, local: 0 });
    expect(locateMatch(counts, 4)).toEqual({ chapter: 2, local: 2 });
    expect(locateMatch(counts, 5)).toBeNull();
    expect(locateMatch([], 0)).toBeNull();
  });

  it('starts from the current chapter, wrapping to the start of the book', () => {
    const counts = [2, 0, 3, 0];
    expect(firstMatchFrom(counts, 0)).toBe(0);
    expect(firstMatchFrom(counts, 1)).toBe(2); // chapter 1 has none: next is chapter 2
    expect(firstMatchFrom(counts, 3)).toBe(0); // nothing after: wrap
  });

  it('reuses parsed runs until the chapter HTML changes', () => {
    const index = new BookTextIndex();
    const a = index.runsFor('c1', '<p>one</p>');
    expect(index.runsFor('c1', '<p>one</p>')).toBe(a);
    expect(index.runsFor('c1', '<p>two</p>')).toEqual(['two']);
  });
});
