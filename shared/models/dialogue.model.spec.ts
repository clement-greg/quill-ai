import { dialogueKey, dialogueSpans, findQuoteSpans, voicedParts } from './dialogue.model';

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
  const voices: Record<string, string> = { ann: 'azure:Ann' };

  it('voices attributed speakers that have a voice; everything else is narration', () => {
    expect(voicedParts(text, spans, ['ann', 'bob'], id => voices[id])).toEqual([
      { text: '"Hi,"', voiceId: 'azure:Ann' },
      { text: ' Ann said. "Bye," Bob said.', voiceId: null },
    ]);
  });

  it('is null when nothing gets its own voice, or the speakers do not fit', () => {
    expect(voicedParts(text, spans, [null, 'bob'], id => voices[id])).toBeNull();
    expect(voicedParts(text, spans, ['ann'], id => voices[id])).toBeNull();
    expect(voicedParts(text, spans, undefined, id => voices[id])).toBeNull();
  });
});
