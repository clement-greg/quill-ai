import { findAnchoredBlock, wrapAnchoredBlock } from './note-anchor';

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

describe('wrapAnchoredBlock', () => {
  function root(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }

  it('wraps the contents of the paragraph in a note span', () => {
    const el = root('<p>First.</p><p>Second <em>bit</em>.</p>');
    expect(wrapAnchoredBlock(el, 'n1', { blockIndex: 1, text: 'Second bit.' })).toBe('Second bit.');
    expect(el.innerHTML).toBe('<p>First.</p><p><span class="note-indicator" data-note-id="n1">Second <em>bit</em>.</span></p>');
  });

  it('wraps a run of loose inline content', () => {
    const el = root('<p>First.</p>Loose <b>text</b>');
    expect(wrapAnchoredBlock(el, 'n2', { blockIndex: 1 })).toBe('Loose text');
    expect(el.innerHTML).toBe('<p>First.</p><span class="note-indicator" data-note-id="n2">Loose <b>text</b></span>');
  });

  it('wraps inside the first item of a list, keeping the list valid', () => {
    const el = root('<ul><li>One</li><li>Two</li></ul>');
    expect(wrapAnchoredBlock(el, 'n3', { blockIndex: 0 })).toBe('One');
    expect(el.innerHTML).toBe('<ul><li><span class="note-indicator" data-note-id="n3">One</span></li><li>Two</li></ul>');
  });

  it('finds paragraphs nested in wrapper divs', () => {
    const el = root('<div><div>A</div><div>B</div></div>');
    expect(wrapAnchoredBlock(el, 'n4', { blockIndex: 0, text: 'B' })).toBe('B');
    expect(el.querySelector('[data-note-id="n4"]')?.textContent).toBe('B');
  });

  it('leaves the content alone when the paragraph is gone', () => {
    const el = root('<p>Only.</p>');
    expect(wrapAnchoredBlock(el, 'n5', { blockIndex: 3, text: 'Missing' })).toBeNull();
    expect(el.innerHTML).toBe('<p>Only.</p>');
  });
});
