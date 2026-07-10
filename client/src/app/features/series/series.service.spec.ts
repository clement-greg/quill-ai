import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { SeriesService } from './series.service';
import { Series } from '@shared/models/series.model';

const MOCK_SERIES: Series = {
  id: 'series-1',
  title: 'Test Series',
};

describe('SeriesService', () => {
  let service: SeriesService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SeriesService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('should be created', () => expect(service).toBeTruthy());

  it('getAll() makes GET /api/series', () => {
    let result: Series[] | undefined;
    service.getAll().subscribe(r => (result = r));
    httpMock.expectOne('/api/series').flush([MOCK_SERIES]);
    expect(result).toEqual([MOCK_SERIES]);
  });

  it('getById() makes GET /api/series/:id', () => {
    let result: Series | undefined;
    service.getById('series-1').subscribe(r => (result = r));
    httpMock.expectOne('/api/series/series-1').flush(MOCK_SERIES);
    expect(result).toEqual(MOCK_SERIES);
  });

  it('create() makes POST /api/series with body', () => {
    let result: Series | undefined;
    service.create(MOCK_SERIES).subscribe(r => (result = r));
    const req = httpMock.expectOne('/api/series');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(MOCK_SERIES);
    req.flush(MOCK_SERIES);
    expect(result).toEqual(MOCK_SERIES);
  });

  it('update() makes PUT /api/series/:id', () => {
    service.update(MOCK_SERIES).subscribe();
    const req = httpMock.expectOne('/api/series/series-1');
    expect(req.request.method).toBe('PUT');
    req.flush(MOCK_SERIES);
  });

  it('delete() makes DELETE /api/series/:id', () => {
    service.delete('series-1').subscribe();
    const req = httpMock.expectOne('/api/series/series-1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('archive() makes PATCH /api/series/:id/archive', () => {
    service.archive('series-1').subscribe();
    const req = httpMock.expectOne('/api/series/series-1/archive');
    expect(req.request.method).toBe('PATCH');
    req.flush(MOCK_SERIES);
  });

  it('unarchive() makes PATCH /api/series/:id/unarchive', () => {
    service.unarchive('series-1').subscribe();
    const req = httpMock.expectOne('/api/series/series-1/unarchive');
    expect(req.request.method).toBe('PATCH');
    req.flush(MOCK_SERIES);
  });

  it('getArchived() makes GET /api/series/archived', () => {
    let result: Series[] | undefined;
    service.getArchived().subscribe(r => (result = r));
    httpMock.expectOne('/api/series/archived').flush([MOCK_SERIES]);
    expect(result).toEqual([MOCK_SERIES]);
  });

  it('addCollaborator() makes POST /api/series/:id/collaborators', () => {
    service.addCollaborator('series-1', 'friend@example.com').subscribe();
    const req = httpMock.expectOne('/api/series/series-1/collaborators');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'friend@example.com' });
    req.flush(MOCK_SERIES);
  });

  it('removeCollaborator() makes DELETE /api/series/:id/collaborators/:email', () => {
    service.removeCollaborator('series-1', 'friend@example.com').subscribe();
    const req = httpMock.expectOne('/api/series/series-1/collaborators/friend%40example.com');
    expect(req.request.method).toBe('DELETE');
    req.flush(MOCK_SERIES);
  });
});
