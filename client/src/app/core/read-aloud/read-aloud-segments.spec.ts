import {
  buildSegments, chapterSpans, cumulativeSeconds, estimateSeconds, findSegmentIndex, formatClock, formatDuration, segmentAtTime, nextChapterStart, previousChapterStart, sortVoices, splitIntoChunks,
} from './read-aloud-segments';
import { ReadAloudVoice } from './read-aloud.model';
import { dialogueBlocks } from './dialogue-paragraphs';

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

describe('buildSegments with a cast', () => {
  const html = '<p>Night.</p><p>"Hi," Ann said. "Yo," said Bob.</p>';
  const key = dialogueBlocks(html)[1]!.key!;
  const chapter = { id: 'a', title: 'One', html, dialogue: { [key]: ['ann', 'bob'] } };

  it('voices dialogue of characters with a voice, leaving the rest to narration', () => {
    const segs = buildSegments([chapter], { voices: { ann: 'azure:Ann' } });
    expect(segs[1]!.parts).toBeUndefined();
    expect(segs[2]!.text).toBe('"Hi," Ann said. "Yo," said Bob.');
    expect(segs[2]!.parts).toEqual([
      { text: '"Hi,"', voiceId: 'azure:Ann' },
      { text: ' Ann said. "Yo," said Bob.', voiceId: null },
    ]);
  });

  it('reads everything as narration without a cast, voices, or a matching attribution', () => {
    expect(buildSegments([chapter]).some(s => s.parts)).toBe(false);
    expect(buildSegments([chapter], { voices: {} }).some(s => s.parts)).toBe(false);
    const edited = { ...chapter, html: html.replace('Hi', 'Hey') };
    expect(buildSegments([edited], { voices: { ann: 'azure:Ann' } }).some(s => s.parts)).toBe(false);
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

describe('chapterSpans', () => {
  it('gives each chapter its start and (exclusive) end in the queue', () => {
    const spans = chapterSpans(buildSegments(BOOK));
    expect(spans.map(s => [s.chapterId, s.start, s.end])).toEqual([['a', 0, 3], ['b', 3, 6], ['c', 6, 7]]);
    expect(spans[1]!.title).toBe('Untitled chapter');
  });

  it('is empty for an empty queue', () => {
    expect(chapterSpans([])).toEqual([]);
  });
});

describe('time estimates', () => {
  const seg = (text: string, blockIndex = 0) =>
    ({ chapterId: 'a', chapterIndex: 0, chapterTitle: 'A', blockIndex, text });

  it('scales with word count and pauses longer after titles', () => {
    expect(estimateSeconds(seg('one two three'.repeat(1)))).toBeCloseTo(3 * 60 / 170 + 0.25);
    expect(estimateSeconds(seg('Title', -1))).toBeCloseTo(60 / 170 + 0.6);
    expect(estimateSeconds(seg('   '))).toBeCloseTo(0.25);
  });

  it('accumulates running totals', () => {
    const totals = cumulativeSeconds([seg('a b'), seg('c')]);
    expect(totals).toHaveLength(3);
    expect(totals[0]).toBe(0);
    expect(totals[2]).toBeCloseTo(3 * 60 / 170 + 0.5);
  });

  it('formats clocks and durations', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(245)).toBe('4:05');
    expect(formatClock(3729)).toBe('1:02:09');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatDuration(20)).toBe('under a minute');
    expect(formatDuration(12 * 60)).toBe('12 min');
    expect(formatDuration(3 * 3600 + 600)).toBe('3 h 10 min');
    expect(formatDuration(7200)).toBe('2 h');
  });
});

describe('segmentAtTime', () => {
  const times = [0, 10, 25, 40, 50]; // four segments

  it('finds the segment playing at a time', () => {
    expect(segmentAtTime(times, 0, 4, 0)).toBe(0);
    expect(segmentAtTime(times, 0, 4, 9.9)).toBe(0);
    expect(segmentAtTime(times, 0, 4, 10)).toBe(1);
    expect(segmentAtTime(times, 0, 4, 39)).toBe(2);
  });

  it('stays within the given range', () => {
    expect(segmentAtTime(times, 1, 3, 0)).toBe(1);
    expect(segmentAtTime(times, 1, 3, 49)).toBe(2);
  });
});
