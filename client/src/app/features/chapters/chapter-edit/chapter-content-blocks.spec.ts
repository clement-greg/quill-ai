import { parseContentBlocks, insertHtmlAtAnchor, collectContentBlocks, blockRange, blockIndexOf } from './chapter-content-blocks';

describe('parseContentBlocks', () => {
  it('lists flat top-level paragraphs', () => {
    const blocks = parseContentBlocks('<p>One</p><p>Two</p><p>Three</p>');
    expect(blocks.map(b => b.text)).toEqual(['One', 'Two', 'Three']);
  });

  it('skips empty spacer blocks', () => {
    const blocks = parseContentBlocks('<p>One</p><div><br></div><p>Two</p>');
    expect(blocks.map(b => b.text)).toEqual(['One', 'Two']);
  });

  it('descends into wrapper divs that contain block children', () => {
    const blocks = parseContentBlocks('<div><div>One</div><div><br></div><div>Two</div></div>');
    expect(blocks.map(b => b.text)).toEqual(['One', 'Two']);
  });

  it('treats a bare top-level text node as a paragraph', () => {
    const blocks = parseContentBlocks('Leading text paragraph<p>Second</p>');
    expect(blocks.map(b => b.text)).toEqual(['Leading text paragraph', 'Second']);
  });

  it('groups a run of inline nodes into one paragraph', () => {
    const blocks = parseContentBlocks(
      '<div><span>Barney\'s</span> was the epitome <span>of</span> dive<div>Next para</div></div>',
    );
    expect(blocks.map(b => b.text)).toEqual(["Barney's was the epitome of dive", 'Next para']);
  });

  it('handles pasted-style content: text node + spacer + wrapper of divs', () => {
    const content =
      'First paragraph as bare text.' +
      '<div><br></div>' +
      '<div><span>Second</span> paragraph inline run<div><br></div><div>Third paragraph</div></div>';
    const blocks = parseContentBlocks(content);
    expect(blocks.map(b => b.text)).toEqual([
      'First paragraph as bare text.',
      'Second paragraph inline run',
      'Third paragraph',
    ]);
  });
});

describe('insertHtmlAtAnchor', () => {
  it('inserts before and after a flat paragraph', () => {
    const content = '<p>One</p><p>Two</p>';
    const [first, second] = parseContentBlocks(content);
    expect(insertHtmlAtAnchor(content, '<p>X</p>', second.anchor, 'before'))
      .toBe('<p>One</p><p>X</p><p>Two</p>');
    expect(insertHtmlAtAnchor(content, '<p>X</p>', first.anchor, 'after'))
      .toBe('<p>One</p><p>X</p><p>Two</p>');
  });

  it('inserts relative to a nested paragraph inside a wrapper div', () => {
    const content = '<div><div>One</div><div>Two</div></div>';
    const [, second] = parseContentBlocks(content);
    expect(insertHtmlAtAnchor(content, '<p>X</p>', second.anchor, 'before'))
      .toBe('<div><div>One</div><p>X</p><div>Two</div></div>');
    expect(insertHtmlAtAnchor(content, '<p>X</p>', second.anchor, 'after'))
      .toBe('<div><div>One</div><div>Two</div><p>X</p></div>');
  });

  it('inserts around an inline run using its start/end nodes', () => {
    const content = '<span>Start</span> middle text<p>Para</p>';
    const [run] = parseContentBlocks(content);
    expect(insertHtmlAtAnchor(content, '<p>X</p>', run.anchor, 'before'))
      .toBe('<p>X</p><span>Start</span> middle text<p>Para</p>');
    expect(insertHtmlAtAnchor(content, '<p>X</p>', run.anchor, 'after'))
      .toBe('<span>Start</span> middle text<p>X</p><p>Para</p>');
  });

  it('appends at the end for a null anchor or empty content', () => {
    expect(insertHtmlAtAnchor('<p>One</p>', '<p>X</p>', null, 'after')).toBe('<p>One</p><p>X</p>');
    expect(insertHtmlAtAnchor('', '<p>X</p>', null, 'after')).toBe('<p>X</p>');
  });

  it('appends at the end when the anchor no longer resolves', () => {
    const stale = { startPath: [9, 9], endPath: [9, 9] };
    expect(insertHtmlAtAnchor('<p>One</p>', '<p>X</p>', stale, 'before')).toBe('<p>One</p><p>X</p>');
  });
});

describe('live block helpers', () => {
  function root(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  }

  it('collects blocks from a live root and ranges over them', () => {
    const el = root('<div><p>One</p><p>Two</p></div>tail <b>run</b>');
    const blocks = collectContentBlocks(el);
    expect(blocks.map(b => b.text)).toEqual(['One', 'Two', 'tail run']);
    expect(blockRange(el, blocks[1]!.anchor)?.toString()).toBe('Two');
    expect(blockRange(el, blocks[2]!.anchor)?.toString()).toBe('tail run');
  });

  it('returns null for an anchor that no longer resolves', () => {
    expect(blockRange(root('<p>x</p>'), { startPath: [4], endPath: [4] })).toBeNull();
  });

  it('finds the block holding a node, or -1', () => {
    const el = root('<p>One</p><p>Two <i>it</i></p>');
    const blocks = collectContentBlocks(el);
    const italic = el.querySelector('i')!.firstChild!;
    expect(blockIndexOf(el, blocks, italic)).toBe(1);
    expect(blockIndexOf(el, blocks, document.createTextNode('elsewhere'))).toBe(-1);
  });
});
