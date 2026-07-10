import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ChapterService } from './chapter.service';
import { Chapter } from '@shared/models/chapter.model';

const MOCK_CHAPTER: Chapter = {
  id: 'chapter-1',
  title: 'Chapter One',
  bookId: 'book-1',
};

describe('ChapterService', () => {
  let service: ChapterService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ChapterService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('should be created', () => expect(service).toBeTruthy());

  it('getAll() makes GET /api/chapters', () => {
    let result: Chapter[] | undefined;
    service.getAll().subscribe(r => (result = r));
    httpMock.expectOne('/api/chapters').flush([MOCK_CHAPTER]);
    expect(result).toEqual([MOCK_CHAPTER]);
  });

  it('getByBook() makes GET /api/chapters/book/:bookId', () => {
    let result: Chapter[] | undefined;
    service.getByBook('book-1').subscribe(r => (result = r));
    httpMock.expectOne('/api/chapters/book/book-1').flush([MOCK_CHAPTER]);
    expect(result).toEqual([MOCK_CHAPTER]);
  });

  it('getById() makes GET /api/chapters/:id', () => {
    let result: Chapter | undefined;
    service.getById('chapter-1').subscribe(r => (result = r));
    httpMock.expectOne('/api/chapters/chapter-1').flush(MOCK_CHAPTER);
    expect(result).toEqual(MOCK_CHAPTER);
  });

  it('create() makes POST /api/chapters with body', () => {
    let result: Chapter | undefined;
    service.create(MOCK_CHAPTER).subscribe(r => (result = r));
    const req = httpMock.expectOne('/api/chapters');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(MOCK_CHAPTER);
    req.flush(MOCK_CHAPTER);
    expect(result).toEqual(MOCK_CHAPTER);
  });

  it('update() makes PUT /api/chapters/:id', () => {
    let result: Chapter | undefined;
    service.update(MOCK_CHAPTER).subscribe(r => (result = r));
    const req = httpMock.expectOne('/api/chapters/chapter-1');
    expect(req.request.method).toBe('PUT');
    req.flush(MOCK_CHAPTER);
    expect(result).toEqual(MOCK_CHAPTER);
  });

  it('delete() makes DELETE /api/chapters/:id', () => {
    service.delete('chapter-1').subscribe();
    const req = httpMock.expectOne('/api/chapters/chapter-1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('reorder() makes PATCH /api/chapters/reorder with items', () => {
    const items = [{ id: 'chapter-1', sortOrder: 0 }];
    service.reorder(items).subscribe();
    const req = httpMock.expectOne('/api/chapters/reorder');
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual(items);
    req.flush(null);
  });
});
