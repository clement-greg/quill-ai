import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ContentFilterService } from './content-filter.service';

const URL = '/api/app-settings/content-filter-terms';

describe('ContentFilterService', () => {
  let service: ContentFilterService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ContentFilterService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('loads terms from the server', async () => {
    const load = service.loadFromServer();
    httpMock.expectOne(URL).flush({ terms: ['foo', 'bar'] });
    await load;
    expect(service.terms()).toEqual(['foo', 'bar']);
  });

  it('keeps the empty default when the server is unavailable', async () => {
    const load = service.loadFromServer();
    httpMock.expectOne(URL).flush('down', { status: 503, statusText: 'Unavailable' });
    await load;
    expect(service.terms()).toEqual([]);
  });

  it('addTerm trims the term, updates the signal, and persists', () => {
    service.addTerm('  foo  ');
    expect(service.terms()).toEqual(['foo']);
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ terms: ['foo'] });
    req.flush({ terms: ['foo'] });
  });

  it('addTerm ignores blank and duplicate terms', () => {
    service.addTerm('foo');
    httpMock.expectOne(URL).flush({ terms: ['foo'] });

    service.addTerm('   ');
    service.addTerm('foo');
    httpMock.expectNone(URL);
    expect(service.terms()).toEqual(['foo']);
  });

  it('removeTerm drops the term and persists the remainder', () => {
    service.addTerm('foo');
    httpMock.expectOne(URL).flush({ terms: ['foo'] });
    service.addTerm('bar');
    httpMock.expectOne(URL).flush({ terms: ['foo', 'bar'] });

    service.removeTerm('foo');
    expect(service.terms()).toEqual(['bar']);
    const req = httpMock.expectOne(URL);
    expect(req.request.body).toEqual({ terms: ['bar'] });
    req.flush({ terms: ['bar'] });
  });

  it('keeps the optimistic update when persistence fails', () => {
    service.addTerm('foo');
    httpMock.expectOne(URL).flush('down', { status: 503, statusText: 'Unavailable' });
    expect(service.terms()).toEqual(['foo']);
  });
});
