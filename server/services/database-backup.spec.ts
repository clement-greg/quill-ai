import yauzl from 'yauzl';

jest.mock('./cosmos', () => {
  const docsByContainer: Record<string, Record<string, unknown>[]> = {
    books: [
      { id: 'b1', title: 'One', owner: 'a@example.com', _rid: 'x', _self: 'y', _etag: 'z', _attachments: 'q', _ts: 1 },
      { id: 'b2', title: 'Two "quoted"\nline', owner: 'a@example.com', _ts: 2 },
    ],
    'chapter-chunks': [{ id: 'c1', chapterId: 'ch1', contentVector: [0.1, 0.2] }],
    empty: [],
  };
  const statusItem = { read: jest.fn(), replace: jest.fn() };
  const appSettings = {
    item: jest.fn(() => statusItem),
    items: { create: jest.fn(), upsert: jest.fn() },
    __statusItem: statusItem,
  };
  const dataContainer = (id: string) => ({
    items: {
      readAll: () => ({
        async *getAsyncIterator() {
          const docs = docsByContainer[id] ?? [];
          // Two pages, to exercise paging.
          yield { resources: docs.slice(0, 1) };
          yield { resources: docs.slice(1) };
        },
      }),
    },
  });
  return {
    getContainer: (name: string) => (name === 'app-settings' ? appSettings : dataContainer(name)),
    listContainerDefinitions: jest.fn(async () => [
      { id: 'chapter-chunks', partitionKey: { paths: ['/chapterId'] }, vectorEmbeddingPolicy: { vectorEmbeddings: [] }, _rid: 'r' },
      { id: 'books', partitionKey: { paths: ['/id'] }, indexingPolicy: { automatic: true } },
      { id: 'empty', partitionKey: { paths: ['/id'] } },
    ]),
  };
});

jest.mock('./storage', () => ({
  uploadStreamToBlobRaw: jest.fn(),
  listBlobsWithPrefix: jest.fn(async () => []),
  deleteBlob: jest.fn(),
}));

import { getContainer } from './cosmos';
import { deleteBlob, listBlobsWithPrefix, uploadStreamToBlobRaw } from './storage';
import {
  backupBlobName,
  getBackupStatus,
  isBackupBlobName,
  isBackupDue,
  selectBackupsToPrune,
  startBackup,
  toBackupDocument,
} from './database-backup';

/* eslint-disable @typescript-eslint/no-explicit-any */
const appSettings = getContainer('app-settings') as any;
const statusItem = appSettings.__statusItem;
const uploadMock = uploadStreamToBlobRaw as jest.Mock;
const listMock = listBlobsWithPrefix as jest.Mock;
const deleteMock = deleteBlob as jest.Mock;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-12T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function readZip(buffer: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const files: Record<string, string> = {};
      zip.on('entry', entry => {
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', c => chunks.push(c));
          stream.on('end', () => {
            files[entry.fileName] = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('backup helpers', () => {
  it('names backups by UTC timestamp and recognizes only those names', () => {
    const name = backupBlobName(new Date('2026-11-12T03:04:05.678Z'));
    expect(name).toBe('backups/quill-backup-2026-11-12T03-04-05Z.zip');
    expect(isBackupBlobName(name)).toBe(true);
    expect(isBackupBlobName('backups/other.zip')).toBe(false);
    expect(isBackupBlobName('photos/quill-backup-2026-11-12T03-04-05Z.zip')).toBe(false);
  });

  it('is due with no history, or a week after the last success', () => {
    expect(isBackupDue(null, NOW)).toBe(true);
    expect(isBackupDue({ lastSuccessAt: ago(6.9), lastAttemptAt: ago(6.9) }, NOW)).toBe(false);
    expect(isBackupDue({ lastSuccessAt: ago(7), lastAttemptAt: ago(7) }, NOW)).toBe(true);
  });

  it('waits six hours after a failed attempt before retrying', () => {
    expect(isBackupDue({ lastSuccessAt: ago(8), lastAttemptAt: ago(0.1) }, NOW)).toBe(false);
    expect(isBackupDue({ lastSuccessAt: ago(8), lastAttemptAt: ago(0.3) }, NOW)).toBe(true);
    expect(isBackupDue({ lastSuccessAt: null, lastAttemptAt: ago(0.1) }, NOW)).toBe(false);
  });

  it('prunes backups older than 31 days but always keeps the newest', () => {
    const blob = (daysAgo: number) => ({
      name: backupBlobName(new Date(NOW.getTime() - daysAgo * DAY)),
      createdOn: new Date(NOW.getTime() - daysAgo * DAY),
      sizeBytes: 1,
    });
    const recent = [blob(1), blob(8), blob(30)];
    const old = [blob(32), blob(60)];
    expect(selectBackupsToPrune([...old, ...recent], NOW).sort()).toEqual(old.map(b => b.name).sort());
    // Backups stopped two months ago: the newest survives anyway.
    expect(selectBackupsToPrune([blob(60), blob(90)], NOW)).toEqual([blob(90).name]);
    // Unrelated blobs under the prefix are never touched.
    expect(selectBackupsToPrune([blob(1), { name: 'backups/keep-me.zip', createdOn: new Date(0), sizeBytes: 1 }], NOW)).toEqual([]);
  });

  it('strips Cosmos system fields but keeps _ts and data', () => {
    expect(toBackupDocument({ id: '1', a: 2, _rid: 'r', _self: 's', _etag: 'e', _attachments: 'a', _ts: 5 }))
      .toEqual({ id: '1', a: 2, _ts: 5 });
  });
});

describe('startBackup', () => {
  let uploaded: Buffer;

  beforeEach(() => {
    jest.clearAllMocks();
    uploaded = Buffer.alloc(0);
    uploadMock.mockImplementation(async (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
      uploaded = Buffer.concat(chunks);
    });
    listMock.mockResolvedValue([]);
  });

  async function waitForRunToFinish(): Promise<void> {
    // The run records its outcome with an upsert as its last status write.
    for (let i = 0; i < 200 && appSettings.items.upsert.mock.calls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
  }

  it('writes every container to a zip with a manifest, then records success', async () => {
    statusItem.read.mockResolvedValue({ resource: undefined });

    const run = await startBackup('manual', 'me@example.com');
    expect(run).toMatchObject({ trigger: 'manual', requestedBy: 'me@example.com', status: 'running' });
    expect(appSettings.items.create).toHaveBeenCalledTimes(1);
    await waitForRunToFinish();

    const [, blobName, contentType] = uploadMock.mock.calls[0];
    expect(isBackupBlobName(blobName)).toBe(true);
    expect(contentType).toBe('application/zip');

    const files = await readZip(uploaded);
    expect(Object.keys(files).sort()).toEqual([
      'README.txt',
      'containers/books.jsonl',
      'containers/chapter-chunks.jsonl',
      'containers/empty.jsonl',
      'manifest.json',
    ]);

    const books = files['containers/books.jsonl'].trim().split('\n').map(l => JSON.parse(l));
    expect(books).toEqual([
      { id: 'b1', title: 'One', owner: 'a@example.com', _ts: 1 },
      { id: 'b2', title: 'Two "quoted"\nline', owner: 'a@example.com', _ts: 2 },
    ]);
    expect(files['containers/empty.jsonl']).toBe('');

    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest).toMatchObject({ formatVersion: 1, database: 'test-db' });
    expect(manifest.containers).toEqual([
      { file: 'containers/books.jsonl', documentCount: 2, definition: { id: 'books', partitionKey: { paths: ['/id'] }, indexingPolicy: { automatic: true } } },
      { file: 'containers/chapter-chunks.jsonl', documentCount: 1, definition: { id: 'chapter-chunks', partitionKey: { paths: ['/chapterId'] }, vectorEmbeddingPolicy: { vectorEmbeddings: [] } } },
      { file: 'containers/empty.jsonl', documentCount: 0, definition: { id: 'empty', partitionKey: { paths: ['/id'] } } },
    ]);

    const status = appSettings.items.upsert.mock.calls[0][0];
    expect(status.lastRun).toMatchObject({ status: 'succeeded', blobName, documentCounts: { books: 2, 'chapter-chunks': 1, empty: 0 } });
    expect(status.lastSuccessAt).toBe(run!.startedAt);
    expect(listMock).toHaveBeenCalledWith('backups/');
  });

  it('records a failure without touching lastSuccessAt or pruning', async () => {
    statusItem.read.mockResolvedValue({ resource: { id: 'database-backup', lastSuccessAt: '2026-01-01T00:00:00.000Z', lastAttemptAt: null, lastRun: null, _etag: 'e1' } });
    uploadMock.mockRejectedValue(new Error('storage down'));

    await startBackup('manual');
    expect(statusItem.replace).toHaveBeenCalledWith(expect.anything(), { accessCondition: { type: 'IfMatch', condition: 'e1' } });
    await waitForRunToFinish();

    const status = appSettings.items.upsert.mock.calls[0][0];
    expect(status.lastRun).toMatchObject({ status: 'failed', error: 'storage down' });
    expect(status.lastSuccessAt).toBe('2026-01-01T00:00:00.000Z');
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('does not start while another run is in progress', async () => {
    statusItem.read.mockResolvedValue({ resource: { id: 'database-backup', lastSuccessAt: null, lastAttemptAt: new Date().toISOString(), lastRun: { trigger: 'scheduled', startedAt: new Date().toISOString(), status: 'running' } } });
    expect(await startBackup('manual')).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('does not start a scheduled run when the last success is under a week old', async () => {
    const recent = new Date(Date.now() - DAY).toISOString();
    statusItem.read.mockResolvedValue({ resource: { id: 'database-backup', lastSuccessAt: recent, lastAttemptAt: recent, lastRun: null } });
    expect(await startBackup('scheduled')).toBeNull();
  });

  it('treats a lost etag race as "already running"', async () => {
    statusItem.read.mockResolvedValue({ resource: { id: 'database-backup', lastSuccessAt: null, lastAttemptAt: null, lastRun: null, _etag: 'e1' } });
    statusItem.replace.mockRejectedValueOnce(Object.assign(new Error('precondition'), { code: 412 }));
    expect(await startBackup('manual')).toBeNull();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('reports backups newest first with the next scheduled time', async () => {
    statusItem.read.mockResolvedValue({ resource: { id: 'database-backup', lastSuccessAt: '2026-11-01T00:00:00.000Z', lastAttemptAt: '2026-11-01T00:00:00.000Z', lastRun: null } });
    listMock.mockResolvedValue([
      { name: 'backups/quill-backup-2026-10-25T00-00-00Z.zip', createdOn: new Date('2026-10-25T00:00:00Z'), sizeBytes: 10 },
      { name: 'backups/quill-backup-2026-11-01T00-00-00Z.zip', createdOn: new Date('2026-11-01T00:00:00Z'), sizeBytes: 20 },
    ]);
    const status = await getBackupStatus();
    expect(status.backups.map(b => b.name)).toEqual([
      'backups/quill-backup-2026-11-01T00-00-00Z.zip',
      'backups/quill-backup-2026-10-25T00-00-00Z.zip',
    ]);
    expect(status.nextScheduledAt).toBe('2026-11-08T00:00:00.000Z');
    expect(status.running).toBe(false);
  });
});
