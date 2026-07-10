import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { BookService } from './book.service';
import { Book } from '@shared/models/book.model';

const MOCK_BOOK: Book = {
  id: 'book-1',
  title: 'Test Book',
  seriesId: 'series-1',
};

describe('BookService', () => {
  let service: BookService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(BookService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('should be created', () => expect(service).toBeTruthy());

  it('getAll() makes GET /api/books', () => {
    let result: Book[] | undefined;
    service.getAll().subscribe(r => (result = r));
    httpMock.expectOne('/api/books').flush([MOCK_BOOK]);
    expect(result).toEqual([MOCK_BOOK]);
  });

  it('getBySeries() makes GET /api/books/series/:id', () => {
    let result: Book[] | undefined;
    service.getBySeries('series-1').subscribe(r => (result = r));
    httpMock.expectOne('/api/books/series/series-1').flush([MOCK_BOOK]);
    expect(result).toEqual([MOCK_BOOK]);
  });

  it('getById() makes GET /api/books/:id', () => {
    let result: Book | undefined;
    service.getById('book-1').subscribe(r => (result = r));
    httpMock.expectOne('/api/books/book-1').flush(MOCK_BOOK);
    expect(result).toEqual(MOCK_BOOK);
  });

  it('create() makes POST /api/books with body', () => {
    let result: Book | undefined;
    service.create(MOCK_BOOK).subscribe(r => (result = r));
    const req = httpMock.expectOne('/api/books');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(MOCK_BOOK);
    req.flush(MOCK_BOOK);
    expect(result).toEqual(MOCK_BOOK);
  });

  it('update() makes PUT /api/books/:id', () => {
    let result: Book | undefined;
    service.update(MOCK_BOOK).subscribe(r => (result = r));
    const req = httpMock.expectOne('/api/books/book-1');
    expect(req.request.method).toBe('PUT');
    req.flush(MOCK_BOOK);
    expect(result).toEqual(MOCK_BOOK);
  });

  it('delete() makes DELETE /api/books/:id', () => {
    service.delete('book-1').subscribe();
    const req = httpMock.expectOne('/api/books/book-1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('archive() makes PATCH /api/books/:id/archive', () => {
    service.archive('book-1').subscribe();
    const req = httpMock.expectOne('/api/books/book-1/archive');
    expect(req.request.method).toBe('PATCH');
    req.flush(MOCK_BOOK);
  });

  it('unarchive() makes PATCH /api/books/:id/unarchive', () => {
    service.unarchive('book-1').subscribe();
    const req = httpMock.expectOne('/api/books/book-1/unarchive');
    expect(req.request.method).toBe('PATCH');
    req.flush(MOCK_BOOK);
  });

  it('softDelete() makes PATCH /api/books/:id/soft-delete', () => {
    service.softDelete('book-1').subscribe();
    const req = httpMock.expectOne('/api/books/book-1/soft-delete');
    expect(req.request.method).toBe('PATCH');
    req.flush(MOCK_BOOK);
  });

  it('restoreDelete() makes PATCH /api/books/:id/restore-delete', () => {
    service.restoreDelete('book-1').subscribe();
    const req = httpMock.expectOne('/api/books/book-1/restore-delete');
    expect(req.request.method).toBe('PATCH');
    req.flush(MOCK_BOOK);
  });

  it('getArchived() makes GET /api/books/archived', () => {
    let result: Book[] | undefined;
    service.getArchived().subscribe(r => (result = r));
    httpMock.expectOne('/api/books/archived').flush([MOCK_BOOK]);
    expect(result).toEqual([MOCK_BOOK]);
  });

  it('reorder() makes PATCH /api/books/reorder with items', () => {
    const items = [{ id: 'book-1', sortOrder: 0 }];
    service.reorder(items).subscribe();
    const req = httpMock.expectOne('/api/books/reorder');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual(items);
    req.flush(null);
  });
});
