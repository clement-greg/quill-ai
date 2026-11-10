import { findReadAloudRange, READ_ALOUD_HIGHLIGHT, revealRange, setReadAloudHighlight } from './read-aloud-highlight';

function root(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('findReadAloudRange', () => {
  it('covers the paragraph at the index', () => {
    const el = root('<p>One</p><p>Two</p>');
    expect(findReadAloudRange(el, 1, 'Two')?.toString()).toBe('Two');
  });

  it('falls back to the nearest paragraph with the same text after edits', () => {
    const el = root('<p>New</p><p>One</p><p>Two</p><p>X</p><p>Two</p>');
    const range = findReadAloudRange(el, 1, 'Two');
    expect(range?.toString()).toBe('Two');
    expect(range?.startOffset).toBe(2);
  });

  it('uses the index when the text changed, and null for titles or missing blocks', () => {
    const el = root('<p>One</p><p>Two edited</p>');
    expect(findReadAloudRange(el, 1, 'Two')?.toString()).toBe('Two edited');
    expect(findReadAloudRange(el, -1, 'Title')).toBeNull();
    expect(findReadAloudRange(el, 5, 'Gone')).toBeNull();
  });
});

describe('setReadAloudHighlight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('registers and clears the custom highlight when supported', () => {
    const highlights = new Map<string, unknown>();
    vi.stubGlobal('CSS', { highlights });
    vi.stubGlobal('Highlight', class { constructor(public range: Range) {} });
    const range = document.createRange();
    setReadAloudHighlight(range);
    expect((highlights.get(READ_ALOUD_HIGHLIGHT) as { range: Range }).range).toBe(range);
    setReadAloudHighlight(null);
    expect(highlights.has(READ_ALOUD_HIGHLIGHT)).toBe(false);
  });

  it('does nothing where the API is missing', () => {
    vi.stubGlobal('CSS', {});
    expect(() => setReadAloudHighlight(document.createRange())).not.toThrow();
  });
});

describe('revealRange', () => {
  it('scrolls the paragraph to the middle when off screen, not when visible', () => {
    const el = root('<p>One</p>');
    const p = el.firstElementChild as HTMLElement;
    p.scrollIntoView = vi.fn();
    const range = document.createRange();
    range.selectNode(p);
    const win = { innerHeight: 800 } as Window;
    range.getBoundingClientRect = () => ({ top: 300, bottom: 340, height: 40 }) as DOMRect;
    revealRange(range, win);
    expect(p.scrollIntoView).not.toHaveBeenCalled();
    range.getBoundingClientRect = () => ({ top: 900, bottom: 940, height: 40 }) as DOMRect;
    revealRange(range, win);
    expect(p.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });
});
