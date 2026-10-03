import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { EntityService, PhotoGenJob } from './entity.service';

describe('EntityService', () => {
  let service: EntityService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(EntityService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  describe('clothesSwap()', () => {
    const JOB: PhotoGenJob = { promptId: 'swap-1', seed: 11, queueNumber: 2, count: 2, tracked: true };

    it('posts the photo, the request and the entity to /api/upload/clothes-swap', () => {
      let result: PhotoGenJob | undefined;
      service
        .clothesSwap('https://blob.test/abc.jpg', { prompt: 'a hat', count: 2 }, 'e-1')
        .subscribe(r => (result = r));

      const req = httpMock.expectOne('/api/upload/clothes-swap');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        url: 'https://blob.test/abc.jpg',
        prompt: 'a hat',
        count: 2,
        entityId: 'e-1',
      });
      req.flush(JOB);
      expect(result).toEqual(JOB);
    });

    it('passes the server error through to the caller', () => {
      let status: number | undefined;
      service
        .clothesSwap('https://blob.test/abc.jpg', { prompt: 'a hat', count: 1 })
        .subscribe({ error: err => (status = err.status) });

      httpMock
        .expectOne('/api/upload/clothes-swap')
        .flush({ error: 'Receiver returned 404' }, { status: 502, statusText: 'Bad Gateway' });
      expect(status).toBe(502);
    });
  });
});
