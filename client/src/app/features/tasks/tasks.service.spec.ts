import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { TasksService, dueLabel, localToday } from './tasks.service';

describe('TasksService', () => {
  let service: TasksService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(TasksService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('getPage sends status, book and trimmed search, omitting empty ones', () => {
    service.getPage({ status: 'open', q: '  flood ', bookId: 'b1' }).subscribe();
    const req = http.expectOne(r => r.url === '/api/tasks');
    expect(req.request.params.get('status')).toBe('open');
    expect(req.request.params.get('bookId')).toBe('b1');
    expect(req.request.params.get('q')).toBe('flood');
    req.flush({ items: [], total: 0, books: [] });

    service.getPage({ status: 'all' }).subscribe();
    const bare = http.expectOne(r => r.url === '/api/tasks');
    expect(bare.request.params.has('bookId')).toBe(false);
    expect(bare.request.params.has('q')).toBe(false);
    bare.flush({ items: [], total: 0, books: [] });
  });

  it('summary sends the browser time zone', () => {
    service.summary(3).subscribe();
    const req = http.expectOne(r => r.url === '/api/tasks/summary');
    expect(req.request.params.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(req.request.params.get('limit')).toBe('3');
    req.flush({ open: 0, overdue: 0, dueThisWeek: 0, next: [] });
  });

  it('bumps changes after a write but not after a read', () => {
    const before = service.changes();
    service.get('t1').subscribe();
    http.expectOne('/api/tasks/t1').flush({});
    expect(service.changes()).toBe(before);

    service.setCompleted('t1', true, 'ch-1').subscribe();
    const req = http.expectOne('/api/tasks/t1/complete');
    expect(req.request.body).toEqual({ completed: true, chapterId: 'ch-1' });
    req.flush({});
    expect(service.changes()).toBe(before + 1);
  });

  it('checkChapter posts both versions and the excluded tasks', () => {
    service.checkChapter('ch-1', '<p>a</p>', '<p>b</p>', ['t9']).subscribe();
    const req = http.expectOne('/api/tasks/check-chapter');
    expect(req.request.body).toEqual({ chapterId: 'ch-1', previousContent: '<p>a</p>', content: '<p>b</p>', excludeTaskIds: ['t9'] });
    req.flush({ candidates: [] });
  });
});

describe('due labels', () => {
  it('describes overdue, today, tomorrow and later dates', () => {
    expect(dueLabel(undefined, '2026-03-02')).toBe('');
    expect(dueLabel('2026-03-01', '2026-03-02')).toMatch(/^Overdue · /);
    expect(dueLabel('2026-03-02', '2026-03-02')).toBe('Due today');
    expect(dueLabel('2026-03-03', '2026-03-02')).toBe('Due tomorrow');
    expect(dueLabel('2026-03-31', '2026-02-28')).toMatch(/^Due /);
    expect(dueLabel('2026-03-01', '2026-02-28')).toBe('Due tomorrow');
  });

  it('formats a local date as YYYY-MM-DD', () => {
    expect(localToday(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
