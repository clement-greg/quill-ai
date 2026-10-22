import { restoreCursor, saveCursor } from './cursor-anchor';

describe('saveCursor / restoreCursor', () => {
  let editor: HTMLElement;

  beforeEach(() => {
    editor = document.createElement('div');
    editor.contentEditable = 'true';
    document.body.appendChild(editor);
  });

  afterEach(() => editor.remove());

  const place = (node: Node, offset: number, endNode = node, endOffset = offset): void => {
    const r = document.createRange();
    r.setStart(node, offset);
    r.setEnd(endNode, endOffset);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  };

  /** Wraps the first occurrence of `text` in a grammar mark, as the grammar check does. */
  const markText = (text: string): void => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let n: Text | null;
    while ((n = walker.nextNode() as Text | null)) {
      const idx = n.data.indexOf(text);
      if (idx === -1) continue;
      const r = document.createRange();
      r.setStart(n, idx);
      r.setEnd(n, idx + text.length);
      const mark = document.createElement('mark');
      mark.className = 'grammar-error';
      r.surroundContents(mark);
      return;
    }
  };

  it('keeps the caret in a new empty paragraph after the text is rewrapped', () => {
    editor.innerHTML = '<p>He was wearing a resparator.</p><p><br></p>';
    const empty = editor.querySelectorAll('p')[1]!;
    place(empty, 0);

    const saved = saveCursor(editor);
    markText('resparator');
    restoreCursor(editor, saved);

    const range = window.getSelection()!.getRangeAt(0);
    expect(range.startContainer).toBe(empty);
    expect(range.startOffset).toBe(0);
    expect(range.collapsed).toBe(true);
  });

  it('keeps the caret in an empty paragraph in the middle of the chapter', () => {
    editor.innerHTML = '<p>First.</p><p><br></p><p>Third paragraph.</p>';
    const empty = editor.querySelectorAll('p')[1]!;
    place(empty, 0);

    const saved = saveCursor(editor);
    markText('Third');
    restoreCursor(editor, saved);

    expect(window.getSelection()!.getRangeAt(0).startContainer).toBe(empty);
  });

  it('keeps the caret at the start of a new paragraph rather than the end of the previous one', () => {
    editor.innerHTML = '<p>Previous paragraph.</p><p>H</p>';
    const second = editor.querySelectorAll('p')[1]!;
    place(second.firstChild!, 0);

    const saved = saveCursor(editor);
    markText('Previous');
    restoreCursor(editor, saved);

    const range = window.getSelection()!.getRangeAt(0);
    expect(second.contains(range.startContainer)).toBe(true);
    expect(range.startOffset).toBe(0);
  });

  it('restores a caret inside text after a mark splits its text node', () => {
    editor.innerHTML = '<p>The quick brown fox.</p>';
    const text = editor.querySelector('p')!.firstChild!;
    place(text, 16); // before "fox"

    const saved = saveCursor(editor);
    markText('quick');
    restoreCursor(editor, saved);

    const range = window.getSelection()!.getRangeAt(0);
    expect(range.startContainer.textContent!.slice(range.startOffset)).toBe('fox.');
  });

  it('restores a selection spanning two paragraphs', () => {
    editor.innerHTML = '<p>Alpha beta.</p><p>Gamma delta.</p>';
    const [p1, p2] = Array.from(editor.querySelectorAll('p'));
    place(p1!.firstChild!, 6, p2!.firstChild!, 5);

    const saved = saveCursor(editor);
    markText('Alpha');
    restoreCursor(editor, saved);

    expect(window.getSelection()!.toString()).toBe('beta.Gamma');
  });

  it('returns null when the selection is outside the editor', () => {
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    place(outside.firstChild!, 2);

    expect(saveCursor(editor)).toBeNull();
    outside.remove();
  });

  it('does nothing when the saved paragraph has been removed', () => {
    editor.innerHTML = '<p>Keep.</p><p>Gone.</p>';
    const gone = editor.querySelectorAll('p')[1]!;
    place(gone.firstChild!, 2);
    const saved = saveCursor(editor);

    const keep = editor.querySelector('p')!;
    place(keep.firstChild!, 1);
    gone.remove();
    restoreCursor(editor, saved);

    expect(window.getSelection()!.getRangeAt(0).startContainer).toBe(keep.firstChild);
  });

  it('clamps to the end of a paragraph whose text got shorter', () => {
    editor.innerHTML = '<p>Long sentence here.</p>';
    const p = editor.querySelector('p')!;
    place(p.firstChild!, 18);
    const saved = saveCursor(editor);

    p.textContent = 'Short';
    restoreCursor(editor, saved);

    const range = window.getSelection()!.getRangeAt(0);
    expect(range.startContainer).toBe(p.firstChild);
    expect(range.startOffset).toBe(5);
  });

  it('is a no-op for a null save', () => {
    expect(() => restoreCursor(editor, null)).not.toThrow();
  });
});
