import { Book } from '@shared/models/book.model';
import { Series } from '@shared/models/series.model';
import { buildLibrary } from './book-library';

const series = (id: string, title: string, extra: Partial<Series> = {}): Series => ({ id, title, ...extra });
const book = (id: string, seriesId: string, extra: Partial<Book> = {}): Book => ({ id, seriesId, title: id.toUpperCase(), ...extra });

describe('buildLibrary', () => {
  const SERIES = [series('z', 'Zebra'), series('a', 'Apple'), series('m', 'Mango')];
  const BOOKS = new Map<string, Book[]>([
    ['z', [book('z2', 'z', { sortOrder: 2 }), book('z1', 'z', { sortOrder: 1, thumnailUrl: 'https://blob/c/z1.png' })]],
    ['a', [book('a1', 'a')]],
    ['m', [book('m1', 'm', { originalUrl: 'https://blob/c/m1.png' })]],
  ]);

  it('lists the current series first, then the rest by title, books in reading order', () => {
    const lib = buildLibrary(SERIES, BOOKS, 'm');
    expect(lib.map(s => s.id)).toEqual(['m', 'a', 'z']);
    expect(lib[2]!.books.map(b => b.id)).toEqual(['z1', 'z2']);
  });

  it('uses the thumbnail, then the original, as the cover', () => {
    const lib = buildLibrary(SERIES, BOOKS);
    const covers = Object.fromEntries(lib.flatMap(s => s.books).map(b => [b.id, b.coverUrl]));
    expect(covers).toEqual({ a1: null, m1: '/api/image/m1.png', z1: '/api/image/z1.png', z2: null });
  });

  it('leaves out archived and deleted series and books, and series with no books', () => {
    const lib = buildLibrary(
      [...SERIES, series('x', 'Gone', { archived: true }), series('d', 'Deleted', { deleted: true }), series('e', 'Empty')],
      new Map<string, Book[]>([
        ...BOOKS,
        ['x', [book('x1', 'x')]],
        ['d', [book('d1', 'd')]],
        ['a', [book('a1', 'a'), book('a2', 'a', { archived: true }), book('a3', 'a', { deleted: true })]],
      ]),
    );
    expect(lib.map(s => s.id)).toEqual(['a', 'm', 'z']);
    expect(lib[0]!.books.map(b => b.id)).toEqual(['a1']);
  });

  it('names untitled series and books', () => {
    const lib = buildLibrary([series('a', '  ')], new Map([['a', [book('a1', 'a', { title: '' })]]]));
    expect(lib[0]!.title).toBe('Untitled series');
    expect(lib[0]!.books[0]!.title).toBe('Untitled book');
  });
});
