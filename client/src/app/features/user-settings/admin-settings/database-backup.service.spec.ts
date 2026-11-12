import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DatabaseBackupService } from './database-backup.service';
import { DatabaseBackupStatus } from '@shared/models/database-backup.model';

const idle: DatabaseBackupStatus = {
  running: false,
  lastSuccessAt: '2026-11-01T00:00:00.000Z',
  nextScheduledAt: '2026-11-08T00:00:00.000Z',
  lastRun: null,
  backups: [],
  restore: null,
};

describe('DatabaseBackupService', () => {
  let service: DatabaseBackupService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(DatabaseBackupService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    service.stopPolling();
    httpMock.verify();
  });

  it('loads status', async () => {
    const load = service.load();
    httpMock.expectOne('/api/backups').flush(idle);
    await load;
    expect(service.status()).toEqual(idle);
    expect(service.loadError()).toBe(false);
  });

  it('flags a load error', async () => {
    const load = service.load();
    httpMock.expectOne('/api/backups').flush('boom', { status: 500, statusText: 'Server Error' });
    await load;
    expect(service.loadError()).toBe(true);
  });

  it('starts a backup and refreshes status', async () => {
    const run = service.runNow();
    const post = httpMock.expectOne('/api/backups/run');
    expect(post.request.method).toBe('POST');
    post.flush({ status: 'running' }, { status: 202, statusText: 'Accepted' });
    await Promise.resolve();
    await Promise.resolve();
    httpMock.expectOne('/api/backups').flush({ ...idle, running: true });
    expect(await run).toBeNull();
    expect(service.status()?.running).toBe(true);
  });

  it('reports a backup already in progress', async () => {
    const run = service.runNow();
    httpMock.expectOne('/api/backups/run').flush({ error: 'busy' }, { status: 409, statusText: 'Conflict' });
    await Promise.resolve();
    await Promise.resolve();
    httpMock.expectOne('/api/backups').flush({ ...idle, running: true });
    expect(await run).toBe('A backup is already running');
  });

  it('addresses backups by file name for delete and restore', async () => {
    const del = service.delete('backups/quill-backup-2026-11-12T15-44-20Z.zip');
    const req = httpMock.expectOne('/api/backups/quill-backup-2026-11-12T15-44-20Z.zip');
    expect(req.request.method).toBe('DELETE');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await Promise.resolve();
    await Promise.resolve();
    httpMock.expectOne('/api/backups').flush(idle);
    expect(await del).toBeNull();

    const restore = service.restore('backups/quill-backup-2026-11-12T15-44-20Z.zip');
    httpMock.expectOne('/api/backups/quill-backup-2026-11-12T15-44-20Z.zip/restore')
      .flush({ error: 'A restore is already running' }, { status: 409, statusText: 'Conflict' });
    expect(await restore).toBe('A restore is already running');
  });
});
