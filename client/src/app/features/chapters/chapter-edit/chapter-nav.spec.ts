import { adjacentChapters } from './chapter-nav';

const chapters = [
  { id: 'a', title: 'One' },
  { id: 'b', title: 'Two' },
  { id: 'c', title: 'Three' },
];

describe('adjacentChapters', () => {
  it('returns both neighbours for a middle chapter', () => {
    expect(adjacentChapters(chapters, 'b')).toEqual({ prev: chapters[0], next: chapters[2] });
  });

  it('has no previous chapter at the start of the book', () => {
    expect(adjacentChapters(chapters, 'a')).toEqual({ prev: null, next: chapters[1] });
  });

  it('has no next chapter at the end of the book', () => {
    expect(adjacentChapters(chapters, 'c')).toEqual({ prev: chapters[1], next: null });
  });

  it('returns nothing when the chapter is the only one', () => {
    expect(adjacentChapters([chapters[0]], 'a')).toEqual({ prev: null, next: null });
  });

  it('returns nothing when the chapter is not in the list', () => {
    expect(adjacentChapters(chapters, 'zzz')).toEqual({ prev: null, next: null });
  });

  it('returns nothing without a current chapter or chapters', () => {
    expect(adjacentChapters(chapters, null)).toEqual({ prev: null, next: null });
    expect(adjacentChapters([], 'a')).toEqual({ prev: null, next: null });
  });
});
