import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { FactCheckReport, SavedFactCheckFinding } from '@shared/models/fact-check.model';
import { FactCheckReportService } from './fact-check-report.service';

function finding(overrides: Partial<SavedFactCheckFinding> = {}): SavedFactCheckFinding {
  return {
    id: 'f-1',
    claim: 'The Titanic sank in 1912.',
    category: 'history',
    verdict: 'verified',
    confidence: 90,
    explanation: 'It did.',
    grounded: false,
    ...overrides,
  };
}

function report(overrides: Partial<FactCheckReport> = {}): FactCheckReport {
  return {
    id: 'r-1',
    docType: 'fact-check-report',
    chapterId: 'ch-1',
    runAt: '2026-02-01T00:00:00Z',
    findings: [finding()],
    total: 1,
    truncated: false,
    stopped: false,
    searchAvailable: true,
    ...overrides,
  };
}

describe('FactCheckReportService', () => {
  let service: FactCheckReportService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(FactCheckReportService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  describe('load', () => {
    it('fetches a chapter’s reports and selects the newest', async () => {
      const pending = service.load('ch-1');
      httpMock.expectOne('/api/fact-check-reports/chapter/ch-1')
        .flush([report({ id: 'r-new' }), report({ id: 'r-old' })]);
      await pending;

      expect(service.reports().map(r => r.id)).toEqual(['r-new', 'r-old']);
      expect(service.selectedId()).toBe('r-new');
      expect(service.hasReports()).toBe(true);
    });

    it('does not refetch the same chapter, so the author keeps their place', async () => {
      const first = service.load('ch-1');
      httpMock.expectOne('/api/fact-check-reports/chapter/ch-1').flush([report(), report({ id: 'r-2' })]);
      await first;
      service.select('r-2');

      await service.load('ch-1');

      httpMock.expectNone('/api/fact-check-reports/chapter/ch-1');
      expect(service.selectedId()).toBe('r-2');
    });

    it('reports a failure instead of showing an empty list as "no reports"', async () => {
      const pending = service.load('ch-1');
      httpMock.expectOne('/api/fact-check-reports/chapter/ch-1')
        .flush('nope', { status: 500, statusText: 'Server Error' });
      await pending;

      expect(service.error()).toBeTruthy();
      expect(service.loading()).toBe(false);
    });
  });

  describe('saveRun', () => {
    it('prepends the saved run and selects it', async () => {
      const pending = service.saveRun({
        chapterId: 'ch-1',
        runAt: '2026-03-01T00:00:00Z',
        findings: [finding()],
        total: 1,
        truncated: false,
        stopped: false,
        searchAvailable: true,
      });
      const req = httpMock.expectOne('/api/fact-check-reports');
      expect(req.request.method).toBe('POST');
      req.flush(report({ id: 'r-saved' }));
      await pending;

      expect(service.reports()[0].id).toBe('r-saved');
      expect(service.selectedId()).toBe('r-saved');
    });

    it('returns null on failure so the caller can keep the live report up', async () => {
      const pending = service.saveRun({
        chapterId: 'ch-1',
        runAt: '2026-03-01T00:00:00Z',
        findings: [finding()],
        total: 1,
        truncated: false,
        stopped: false,
        searchAvailable: true,
      });
      httpMock.expectOne('/api/fact-check-reports')
        .flush('nope', { status: 500, statusText: 'Server Error' });

      expect(await pending).toBeNull();
      expect(service.error()).toBeTruthy();
      expect(service.reports()).toEqual([]);
    });
  });

  describe('setResolved', () => {
    beforeEach(async () => {
      const pending = service.load('ch-1');
      httpMock.expectOne('/api/fact-check-reports/chapter/ch-1')
        .flush([report({ findings: [finding(), finding({ id: 'f-2', verdict: 'disputed' })] })]);
      await pending;
    });

    it('ticks the finding off locally before the write lands, then keeps it', async () => {
      const pending = service.setResolved('r-1', 'f-1', true);
      // The checkbox must not wait on the round trip.
      expect(service.selected()!.findings[0].resolved).toBe(true);
      expect(service.openCount()).toBe(1);

      const req = httpMock.expectOne('/api/fact-check-reports/r-1/findings/f-1');
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({ chapterId: 'ch-1', resolved: true });
      req.flush(report());
      await pending;

      expect(service.selected()!.findings[0].resolved).toBe(true);
    });

    it('rolls the tick back when the write fails', async () => {
      const pending = service.setResolved('r-1', 'f-1', true);
      httpMock.expectOne('/api/fact-check-reports/r-1/findings/f-1')
        .flush('nope', { status: 500, statusText: 'Server Error' });
      await pending;

      expect(service.selected()!.findings[0].resolved).toBeFalsy();
      expect(service.error()).toBeTruthy();
    });

    it('counts only unresolved disputes as still open', async () => {
      expect(service.openDisputedCount()).toBe(1);

      const pending = service.setResolved('r-1', 'f-2', true);
      httpMock.expectOne('/api/fact-check-reports/r-1/findings/f-2').flush(report());
      await pending;

      expect(service.openDisputedCount()).toBe(0);
    });
  });

  describe('remove', () => {
    it('deletes the report and falls back to the next newest', async () => {
      const pending = service.load('ch-1');
      httpMock.expectOne('/api/fact-check-reports/chapter/ch-1')
        .flush([report({ id: 'r-new' }), report({ id: 'r-old' })]);
      await pending;

      const removing = service.remove('r-new');
      httpMock.expectOne(r => r.url === '/api/fact-check-reports/r-new' && r.method === 'DELETE')
        .flush(null);
      await removing;

      expect(service.reports().map(r => r.id)).toEqual(['r-old']);
      expect(service.selectedId()).toBe('r-old');
    });
  });
});
