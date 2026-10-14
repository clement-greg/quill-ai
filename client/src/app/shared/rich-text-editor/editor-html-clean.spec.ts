import { cleanEditorHtml } from './editor-html-clean';

describe('cleanEditorHtml', () => {
  it('returns clean HTML unchanged', () => {
    const html = '<p>Plain <span class="entity-reference" data-id="e1">Hector</span> text.</p>';
    expect(cleanEditorHtml(html)).toBe(html);
  });

  it('unwraps find-in-page highlights, including the active match', () => {
    const html = '<p>just <mark data-search-match="">blue</mark>-collar and <mark data-search-match="" class="search-match-active">Blue</mark> sky</p>';
    expect(cleanEditorHtml(html)).toBe('<p>just blue-collar and Blue sky</p>');
  });

  it('unwraps a search highlight nested inside a note without touching the note', () => {
    const html = '<p><span class="note-indicator" data-note-id="n1"> <mark data-search-match="" class="search-match-active">blue</mark> sun</span></p>';
    expect(cleanEditorHtml(html)).toBe('<p><span class="note-indicator" data-note-id="n1"> blue sun</span></p>');
  });

  it('unwraps grammar marks and font wrappers, and removes AI insertion markers', () => {
    const html = '<p><mark class="grammar-error" data-grammar-suggestion="x">teh</mark> <font color="red">cat</font><span class="ai-insertion-marker"></span></p>';
    expect(cleanEditorHtml(html)).toBe('<p>teh cat</p>');
  });

  it('merges the text left split by unwrapping', () => {
    const d = document.createElement('div');
    d.innerHTML = cleanEditorHtml('<p>a<mark data-search-match="">b</mark>c</p>');
    expect(d.querySelector('p')!.childNodes.length).toBe(1);
  });

  it('leaves other marks alone', () => {
    const html = '<p><mark class="quill-review-highlight">kept</mark></p>';
    expect(cleanEditorHtml(html)).toBe(html);
  });
});
