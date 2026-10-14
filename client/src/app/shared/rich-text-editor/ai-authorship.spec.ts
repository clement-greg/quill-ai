import { clearAiMarkOnEmptyBlocks } from './ai-authorship';

describe('clearAiMarkOnEmptyBlocks', () => {
  const build = (html: string): HTMLElement => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d;
  };

  it('clears the mark from an empty AI paragraph', () => {
    const d = build('<p data-ai-generated="true"><br></p>');
    const p = d.querySelector('p')!;
    expect(clearAiMarkOnEmptyBlocks([p])).toBe(true);
    expect(p.hasAttribute('data-ai-generated')).toBe(false);
  });

  it('treats whitespace and zero-width spaces as empty', () => {
    const d = build('<p data-ai-generated="modified"> ​ </p>');
    const p = d.querySelector('p')!;
    expect(clearAiMarkOnEmptyBlocks([p])).toBe(true);
    expect(p.hasAttribute('data-ai-generated')).toBe(false);
  });

  it('keeps the mark on a paragraph that still has text', () => {
    const d = build('<p data-ai-generated="true">AI words</p>');
    const p = d.querySelector('p')!;
    expect(clearAiMarkOnEmptyBlocks([p])).toBe(false);
    expect(p.getAttribute('data-ai-generated')).toBe('true');
  });

  it('only clears the empty side of a split paragraph', () => {
    const d = build('<p data-ai-generated="true">AI words</p><p data-ai-generated="true"><br></p>');
    const [full, empty] = Array.from(d.querySelectorAll('p'));
    expect(clearAiMarkOnEmptyBlocks([full, empty])).toBe(true);
    expect(full.getAttribute('data-ai-generated')).toBe('true');
    expect(empty.hasAttribute('data-ai-generated')).toBe(false);
  });

  it('ignores nulls, duplicates, unmarked blocks and AI spans', () => {
    const d = build('<p><br></p><span data-ai-generated="true"></span>');
    const p = d.querySelector('p')!;
    const span = d.querySelector('span')!;
    expect(clearAiMarkOnEmptyBlocks([null, p, p, span])).toBe(false);
    expect(span.getAttribute('data-ai-generated')).toBe('true');
  });
});
