import { dialogueKey, dialogueSpans, findQuoteSpans, voicedParts, voiceRateOf } from './dialogue.model';

describe('findQuoteSpans', () => {
  it('finds straight and curly quotes, marks included', () => {
    const text = '"Hi," she said. “Bye.”';
    expect(findQuoteSpans(text).map(s => text.slice(s.start, s.end))).toEqual(['"Hi,"', '“Bye.”']);
  });

  it('runs an unclosed quote to the end of the paragraph', () => {
    const text = 'He said, “And then we ran';
    expect(findQuoteSpans(text).map(s => text.slice(s.start, s.end))).toEqual(['“And then we ran']);
  });

  it('ignores apostrophes and empty quotes', () => {
    expect(findQuoteSpans("It's Tom's \"\" thing")).toEqual([]);
  });

  it('ignores inch marks in measurements', () => {
    expect(findQuoteSpans('Alisha was a 5\'11" powerfully built woman.')).toEqual([]);
    expect(findQuoteSpans('A 12" ruler and a 6\' 2" man.')).toEqual([]);
    const text = '"He\'s 6\'2" and mean," she said.';
    expect(findQuoteSpans(text).map(s => text.slice(s.start, s.end))).toEqual(['"He\'s 6\'2" and mean,"']);
  });

  it('still closes a quote that ends in a number', () => {
    const text = '"I\'m 30" he said.';
    expect(findQuoteSpans(text).map(s => text.slice(s.start, s.end))).toEqual(['"I\'m 30"']);
  });
});

describe('dialogueSpans', () => {
  const text = 'Where is she? He looked around. "Here," Ann said. I *really* do.';
  it('adds italic thoughts of three words or more, skipping emphasis and overlaps', () => {
    const thought = { start: 0, end: 14 }; // "Where is she? " (trailing space trimmed)
    const emphasis = { start: text.indexOf('really'), end: text.indexOf('really') + 6 };
    const overlap = { start: text.indexOf('"Here'), end: text.indexOf('Ann') };
    const spans = dialogueSpans(text, [emphasis, overlap, thought]);
    expect(spans.map(s => text.slice(s.start, s.end))).toEqual(['Where is she?', '"Here,"']);
  });
});

describe('dialogueKey', () => {
  it('changes when the text or the spans change', () => {
    const spans = findQuoteSpans('"Hi," she said.');
    const key = dialogueKey('"Hi," she said.', spans);
    expect(dialogueKey('"Hi," she said.', spans)).toBe(key);
    expect(dialogueKey('"Hey," she said.', findQuoteSpans('"Hey," she said.'))).not.toBe(key);
    expect(dialogueKey('"Hi," she said.', [])).not.toBe(key);
  });
});

describe('voicedParts', () => {
  const text = '"Hi," Ann said. "Bye," Bob said.';
  const spans = findQuoteSpans(text);
  const voices: Record<string, { voiceId: string | null; rate?: number }> = { ann: { voiceId: 'azure:Ann' } };

  it('voices attributed speakers that have a voice; everything else is narration', () => {
    expect(voicedParts(text, spans, ['ann', 'bob'], id => voices[id])).toEqual([
      { text: '"Hi,"', voiceId: 'azure:Ann' },
      { text: ' Ann said. "Bye," Bob said.', voiceId: null },
    ]);
  });

  it('gives a speaker their speed, with or without their own voice', () => {
    const speeds = { ann: { voiceId: 'azure:Ann', rate: 1.25 }, bob: { voiceId: null, rate: 0.8 } };
    expect(voicedParts(text, spans, ['ann', 'bob'], id => speeds[id as 'ann' | 'bob'])).toEqual([
      { text: '"Hi,"', voiceId: 'azure:Ann', rate: 1.25 },
      { text: ' Ann said. ', voiceId: null },
      { text: '"Bye,"', voiceId: null, rate: 0.8 },
      { text: ' Bob said.', voiceId: null },
    ]);
  });

  it('is null when nothing gets its own voice, or the speakers do not fit', () => {
    expect(voicedParts(text, spans, [null, 'bob'], id => voices[id])).toBeNull();
    expect(voicedParts(text, spans, ['ann'], id => voices[id])).toBeNull();
    expect(voicedParts(text, spans, undefined, id => voices[id])).toBeNull();
  });
});

describe('voiceRateOf', () => {
  it('keeps listed speeds other than normal', () => {
    expect(voiceRateOf(1.25)).toBe(1.25);
    expect(voiceRateOf(1.15)).toBe(1.15);
    expect(voiceRateOf(1)).toBeUndefined();
    expect(voiceRateOf(3)).toBeUndefined();
    expect(voiceRateOf('fast')).toBeUndefined();
  });
});
