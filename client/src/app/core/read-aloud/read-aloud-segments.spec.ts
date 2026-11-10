import {
  buildSegments, findSegmentIndex, nextChapterStart, previousChapterStart, sortVoices, splitIntoChunks,
} from './read-aloud-segments';
import { ReadAloudVoice } from './read-aloud.model';

const BOOK = [
  { id: 'a', title: 'Arrival', html: '<p>One.</p><p>Two.</p>' },
  { id: 'b', title: '  ', html: '<p>Three.</p><div><br></div><p>Four.</p>' },
  { id: 'c', title: 'End', html: '' },
];

describe('buildSegments', () => {
  it('queues each chapter title followed by its paragraphs', () => {
    const segs = buildSegments(BOOK);
    expect(segs.map(s => [s.chapterId, s.blockIndex, s.text])).toEqual([
      ['a', -1, 'Arrival'], ['a', 0, 'One.'], ['a', 1, 'Two.'],
      ['b', -1, 'Untitled chapter'], ['b', 0, 'Three.'], ['b', 1, 'Four.'],
      ['c', -1, 'End'],
    ]);
    expect(segs[4]!.chapterIndex).toBe(1);
  });

  it('returns nothing for no chapters', () => {
    expect(buildSegments([])).toEqual([]);
  });
});

describe('findSegmentIndex', () => {
  const segs = buildSegments(BOOK);
  it('finds a chapter start and a specific paragraph', () => {
    expect(findSegmentIndex(segs, 'b')).toBe(3);
    expect(findSegmentIndex(segs, 'b', 1)).toBe(5);
  });
  it('falls back to the chapter start, or 0 for an unknown chapter', () => {
    expect(findSegmentIndex(segs, 'b', 9)).toBe(3);
    expect(findSegmentIndex(segs, 'b', -1)).toBe(3);
    expect(findSegmentIndex(segs, 'zzz', 1)).toBe(0);
  });
});

describe('chapter skipping', () => {
  const segs = buildSegments(BOOK);
  it('jumps to the next chapter, or -1 from the last', () => {
    expect(nextChapterStart(segs, 1)).toBe(3);
    expect(nextChapterStart(segs, 5)).toBe(6);
    expect(nextChapterStart(segs, 6)).toBe(-1);
    expect(nextChapterStart(segs, 99)).toBe(-1);
  });
  it('restarts the chapter when partway in, else goes back a chapter', () => {
    expect(previousChapterStart(segs, 5)).toBe(3);
    expect(previousChapterStart(segs, 4)).toBe(0);
    expect(previousChapterStart(segs, 3)).toBe(0);
    expect(previousChapterStart(segs, 1)).toBe(0);
    expect(previousChapterStart([], 0)).toBe(0);
  });
});

describe('splitIntoChunks', () => {
  it('groups whole sentences up to the limit', () => {
    expect(splitIntoChunks('Hi there. How are you? Fine!', 20)).toEqual(['Hi there.', 'How are you? Fine!']);
  });
  it('keeps closing quotes with their sentence', () => {
    expect(splitIntoChunks('"Run!" she said. Then silence.', 18)).toEqual(['"Run!" she said.', 'Then silence.']);
  });
  it('breaks overlong sentences at commas, then spaces', () => {
    const chunks = splitIntoChunks('alpha beta gamma, delta epsilon zeta eta theta iota kappa', 24);
    expect(chunks.every(c => c.length <= 24)).toBe(true);
    expect(chunks[0]).toBe('alpha beta gamma,');
    expect(chunks.join(' ')).toBe('alpha beta gamma, delta epsilon zeta eta theta iota kappa');
  });
  it('hard-splits a word longer than the limit', () => {
    expect(splitIntoChunks('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('handles text without punctuation and empty text', () => {
    expect(splitIntoChunks('  no  punctuation here ')).toEqual(['no punctuation here']);
    expect(splitIntoChunks('   ')).toEqual([]);
  });
});

describe('sortVoices', () => {
  const v = (id: string, lang: string, quality: ReadAloudVoice['quality']): ReadAloudVoice => ({ id, name: id, lang, quality });
  it('keeps the reader language, best quality and exact locale first', () => {
    const sorted = sortVoices([
      v('Zed', 'en-GB', 'default'), v('Amy', 'en-US', 'default'), v('Pia', 'fr-FR', 'premium'),
      v('Nat', 'en_GB', 'premium'), v('Ava', 'en-US', 'premium'), v('Eve', 'en-AU', 'enhanced'),
    ], 'en-US');
    expect(sorted.map(x => x.id)).toEqual(['Ava', 'Nat', 'Eve', 'Amy', 'Zed']);
  });
});
