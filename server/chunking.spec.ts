import { chunkHtmlContent } from './chunking';

describe('chunkHtmlContent', () => {
  it('returns an empty array for empty/missing content', () => {
    expect(chunkHtmlContent('')).toEqual([]);
    expect(chunkHtmlContent(undefined)).toEqual([]);
    expect(chunkHtmlContent(null)).toEqual([]);
    expect(chunkHtmlContent('   <p></p>  ')).toEqual([]);
  });

  it('strips HTML tags and entities from each chunk', () => {
    const chunks = chunkHtmlContent('<p>Hello&nbsp;<strong>world</strong>.</p>');
    expect(chunks).toEqual(['Hello world .']);
  });

  it('packs multiple short paragraphs into a single chunk', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    const chunks = chunkHtmlContent(html);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('starts a new chunk when the budget would be exceeded', () => {
    const para = '<p>' + 'a'.repeat(80) + '</p>';
    const html = para.repeat(4);
    const chunks = chunkHtmlContent(html, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('hard-splits a single paragraph that exceeds the budget', () => {
    const words = Array.from({ length: 60 }, () => 'word').join(' ');
    const chunks = chunkHtmlContent(`<p>${words}</p>`, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
    // No content is lost.
    expect(chunks.join(' ').split(' ').filter(w => w === 'word')).toHaveLength(60);
  });

  it('treats line breaks and list items as paragraph boundaries', () => {
    const html = '<li>One</li><li>Two</li>';
    const chunks = chunkHtmlContent(html, 6);
    expect(chunks).toEqual(['One', 'Two']);
  });
});
