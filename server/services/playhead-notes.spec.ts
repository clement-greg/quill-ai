import { parseClientPlayhead, playheadAnchor, playheadGuidance } from './playhead-notes';
import { noteAnchorExcerpt } from '../../shared/models/chapter.model';

const valid = { bookId: 'b1', bookTitle: 'Book', chapterId: 'c1', chapterTitle: 'One', blockIndex: 2, text: ' Para ' };

describe('parseClientPlayhead', () => {
  it('reads a well-formed play head, trimming its text', () => {
    expect(parseClientPlayhead(valid)).toEqual({ ...valid, text: 'Para' });
  });

  it('drops empty text and caps long text', () => {
    expect(parseClientPlayhead({ ...valid, text: '' })).not.toHaveProperty('text');
    expect(parseClientPlayhead({ ...valid, text: 'x'.repeat(400) })!.text).toHaveLength(300);
  });

  it('rejects anything malformed', () => {
    expect(parseClientPlayhead(undefined)).toBeNull();
    expect(parseClientPlayhead('b1')).toBeNull();
    expect(parseClientPlayhead({ ...valid, chapterId: '' })).toBeNull();
    expect(parseClientPlayhead({ ...valid, bookId: 3 })).toBeNull();
    expect(parseClientPlayhead({ ...valid, blockIndex: -2 })).toBeNull();
    expect(parseClientPlayhead({ ...valid, blockIndex: 1.5 })).toBeNull();
  });
});

describe('playheadAnchor', () => {
  it('anchors to the paragraph, or not at all on the chapter title', () => {
    expect(playheadAnchor({ ...valid, text: 'Para' })).toEqual({ blockIndex: 2, text: 'Para' });
    expect(playheadAnchor({ ...valid, text: undefined })).toEqual({ blockIndex: 2 });
    expect(playheadAnchor({ ...valid, blockIndex: -1 })).toBeUndefined();
  });
});

describe('playheadGuidance', () => {
  it('is empty without a play head and names the spot with one', () => {
    expect(playheadGuidance(null)).toBe('');
    const text = playheadGuidance({ ...valid, text: 'Para' });
    expect(text).toContain('chapter "One" of "Book", at the paragraph beginning "Para"');
    expect(text).toContain('add_chapter_note WITHOUT chapterName');
  });
});

describe('noteAnchorExcerpt', () => {
  it('keeps short text and cuts long text at a word', () => {
    expect(noteAnchorExcerpt('  a   b ')).toBe('a b');
    expect(noteAnchorExcerpt(undefined)).toBe('');
    expect(noteAnchorExcerpt('alpha beta gamma delta', 12)).toBe('alpha beta…');
  });
});
