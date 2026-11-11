import { findAnchoredBlock, findAnchoredWord, wrapAnchoredBlock } from './note-anchor';

describe('findAnchoredBlock', () => {
  const texts = ['Alpha one.', 'Bravo two is long.', 'Charlie three.', 'Bravo two is long.'];

  it('uses the index when the paragraph there still matches', () => {
    expect(findAnchoredBlock(texts, { blockIndex: 1, text: 'Bravo two is long.' })).toBe(1);
  });

  it('follows the paragraph when it has moved, to the nearest copy', () => {
    expect(findAnchoredBlock(texts, { blockIndex: 0, text: 'Charlie three.' })).toBe(2);
    expect(findAnchoredBlock(texts, { blockIndex: 3, text: 'Bravo two is long.' })).toBe(3);
  });

  it('matches a paragraph from the start of its text, ignoring spacing', () => {
    expect(findAnchoredBlock(texts, { blockIndex: 0, text: 'Bravo   two' })).toBe(1);
  });

  it('falls back to the index when the paragraph was rewritten or no text was kept', () => {
    expect(findAnchoredBlock(texts, { blockIndex: 2, text: 'Something else entirely' })).toBe(2);
    expect(findAnchoredBlock(texts, { blockIndex: 0 })).toBe(0);
  });

  it('gives up when the index no longer exists', () => {
    expect(findAnchoredBlock(texts, { blockIndex: 9, text: 'gone' })).toBe(-1);
    expect(findAnchoredBlock([], { blockIndex: 0 })).toBe(-1);
  });
});

describe('findAnchoredWord', () => {
  const text = 'The keeper counted the ships, and the keeper\u2019s log was well-kept.';
  const at = (range: [number, number] | null) => (range ? text.slice(...range) : null);

  it('uses the recorded word at its offset', () => {
    expect(at(findAnchoredWord(text, { blockIndex: 0, wordOffset: 4, word: 'keeper' }))).toBe('keeper');
    expect(at(findAnchoredWord(text, { blockIndex: 0, wordOffset: 19, word: 'the' }))).toBe('the');
  });

  it('finds the same word nearest its old offset when the paragraph changed', () => {
    expect(findAnchoredWord(text, { blockIndex: 0, wordOffset: 40, word: 'the' })).toEqual([34, 37]);
    expect(at(findAnchoredWord(text, { blockIndex: 0, wordOffset: 0, word: 'SHIPS' }))).toBe('ships');
  });

  it('falls back to the last word when no word was recorded or it is gone', () => {
    expect(at(findAnchoredWord(text, { blockIndex: 0 }))).toBe('well-kept');
    expect(at(findAnchoredWord(text, { blockIndex: 0, wordOffset: 3, word: 'lighthouse' }))).toBe('well-kept');
  });

  it('keeps apostrophes inside words and has nothing for a wordless paragraph', () => {
    expect(at(findAnchoredWord(text, { blockIndex: 0, wordOffset: 38, word: 'keeper\u2019s' }))).toBe('keeper\u2019s');
    expect(findAnchoredWord(' — … ', { blockIndex: 0 })).toBeNull();
  });
});

describe('wrapAnchoredBlock', () => {
  function root(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }
  const span = (id: string, text: string) => `<span class="note-indicator" data-note-id="${id}">${text}</span>`;

  it('wraps the word being read', () => {
    const el = root('<p>First.</p><p>Second   <em>bit</em> here.</p>');
    expect(wrapAnchoredBlock(el, 'n1', { blockIndex: 1, text: 'Second bit here.', wordOffset: 7, word: 'bit' })).toBe('bit');
    expect(el.innerHTML).toBe(`<p>First.</p><p>Second   <em>${span('n1', 'bit')}</em> here.</p>`);
  });

  it('wraps the last word of the paragraph when the word is unknown', () => {
    const el = root('<p>First.</p><p>Second <em>bit</em> here.</p>');
    expect(wrapAnchoredBlock(el, 'n2', { blockIndex: 1, text: 'Second bit here.' })).toBe('here');
    expect(el.innerHTML).toBe(`<p>First.</p><p>Second <em>bit</em> ${span('n2', 'here')}.</p>`);
  });

  it('wraps a word that spans formatting', () => {
    const el = root('<p>A <b>light</b>house stood.</p>');
    expect(wrapAnchoredBlock(el, 'n3', { blockIndex: 0, wordOffset: 2, word: 'lighthouse' })).toBe('lighthouse');
    expect(el.querySelector('[data-note-id="n3"]')?.textContent).toBe('lighthouse');
    expect(el.textContent).toBe('A lighthouse stood.');
  });

  it('finds words in loose inline content and lists', () => {
    const loose = root('<p>First.</p>Loose <b>text</b>');
    expect(wrapAnchoredBlock(loose, 'n4', { blockIndex: 1 })).toBe('text');
    expect(loose.innerHTML).toBe(`<p>First.</p>Loose <b>${span('n4', 'text')}</b>`);

    const list = root('<ul><li>One two</li><li>Three</li></ul>');
    expect(wrapAnchoredBlock(list, 'n5', { blockIndex: 0, wordOffset: 0, word: 'One' })).toBe('One');
    expect(list.innerHTML).toBe(`<ul><li>${span('n5', 'One')} two</li><li>Three</li></ul>`);

    // List items run together ("twoThree"), so that isn't a word to wrap: fall back to the first item.
    const joined = root('<ul><li>One two</li><li>Three</li></ul>');
    expect(wrapAnchoredBlock(joined, 'n8', { blockIndex: 0 })).toBe('One two');
    expect(joined.innerHTML).toBe(`<ul><li>${span('n8', 'One two')}</li><li>Three</li></ul>`);
  });

  it('wraps the whole paragraph when it has no words', () => {
    const el = root('<p>— …</p>');
    expect(wrapAnchoredBlock(el, 'n6', { blockIndex: 0 })).toBe('— …');
    expect(el.innerHTML).toBe(`<p>${span('n6', '— …')}</p>`);
  });

  it('leaves the content alone when the paragraph is gone', () => {
    const el = root('<p>Only.</p>');
    expect(wrapAnchoredBlock(el, 'n7', { blockIndex: 3, text: 'Missing' })).toBeNull();
    expect(el.innerHTML).toBe('<p>Only.</p>');
  });
});
