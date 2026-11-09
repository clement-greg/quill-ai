import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ThoughtsService } from './thoughts.service';

describe('ThoughtsService', () => {
  let service: ThoughtsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(ThoughtsService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('getPage sends offset and limit, and no tags param when unfiltered', () => {
    service.getPage({ offset: 100, limit: 50 }).subscribe();
    const req = http.expectOne((r) => r.url === '/api/thoughts');
    expect(req.request.params.get('offset')).toBe('100');
    expect(req.request.params.get('limit')).toBe('50');
    expect(req.request.params.has('tags')).toBe(false);
    req.flush({ items: [], total: 0, tags: [] });
  });

  it('getPage joins filter tags with commas', () => {
    service.getPage({ tags: ['Plot', 'big idea'], offset: 0, limit: 50 }).subscribe();
    const req = http.expectOne((r) => r.url === '/api/thoughts');
    expect(req.request.params.get('tags')).toBe('Plot,big idea');
    req.flush({ items: [], total: 0, tags: [] });
  });
});
