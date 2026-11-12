import fs from 'fs';
import os from 'os';
import path from 'path';
import yazl from 'yazl';

jest.mock('./cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  const live = new Set(['books', 'app-settings']);
  // The fake answers every query with whole documents; the restore asks for
  // `SELECT VALUE c.id`, so project to ids here.
  const getContainer = (name: string) => {
    const c = fake.getContainer(name);
    return {
      item: c.item,
      items: {
        create: c.items.create,
        upsert: c.items.upsert,
        query: (q: string) => ({
          fetchAll: async () => ({
            resources: q.startsWith('SELECT VALUE c.id') ? c.all().map((d: any) => d.id) : c.all(),
          }),
        }),
      },
    };
  };
  return {
    getContainer,
    listContainerDefinitions: jest.fn(async () => [...live].map(id => ({ id }))),
    createContainerIfMissing: jest.fn(async (def: { id: string }) => { live.add(def.id); return getContainer(def.id); }),
    __fake: fake,
    __live: live,
  };
});

jest.mock('./storage', () => ({ downloadBlobStreamRaw: jest.fn() }));

import { downloadBlobStreamRaw } from './storage';
import { createContainerIfMissing } from './cosmos';
import { FakeCosmos } from '../testing/fake-cosmos';
import { getRestoreRun, previewRestore, startRestore } from './database-restore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const cosmosMock = jest.requireMock('./cosmos');
const fake = cosmosMock.__fake as FakeCosmos;
const live = cosmosMock.__live as Set<string>;

let zipPath: string;

function buildZip(file: string): Promise<void> {
  const zip = new yazl.ZipFile();
  const manifest = {
    formatVersion: 1, database: 'story-time', createdAt: '2026-11-12T15:44:20.000Z',
    containers: [
      { file: 'containers/books.jsonl', documentCount: 3, definition: { id: 'books', partitionKey: { paths: ['/id'] } } },
      { file: 'containers/maps.jsonl', documentCount: 1, definition: { id: 'maps', partitionKey: { paths: ['/id'] } } },
    ],
  };
  const books = [
    { id: 'b1', title: 'Backed-up title' },
    { id: 'b2', title: 'Deleted since' },
    { id: 'b3', title: 'Also deleted' },
  ];
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
  zip.addBuffer(Buffer.from(books.map(b => JSON.stringify(b)).join('\n') + '\n'), 'containers/books.jsonl');
  zip.addBuffer(Buffer.from(JSON.stringify({ id: 'm1', name: 'Map' }) + '\n'), 'containers/maps.jsonl');
  zip.end();
  return new Promise((resolve, reject) => {
    zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
  });
}

beforeAll(async () => {
  zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-spec-')), 'b.zip');
  await buildZip(zipPath);
});

beforeEach(() => {
  fake.reset();
  live.clear();
  live.add('books');
  live.add('app-settings');
  (createContainerIfMissing as jest.Mock).mockClear();
  (downloadBlobStreamRaw as jest.Mock).mockImplementation(async () => ({ stream: fs.createReadStream(zipPath), contentType: 'application/zip' }));
  // b1 still exists, with newer content that must survive the restore.
  fake.container('books').seed({ id: 'b1', title: 'Edited after the backup' });
});

async function waitForRestore(): Promise<void> {
  for (let i = 0; i < 200 && getRestoreRun()?.status === 'running'; i++) await new Promise(r => setTimeout(r, 5));
}

describe('database restore', () => {
  it('previews what would be added and skipped without writing', async () => {
    const preview = await previewRestore('backups/x.zip');
    expect(preview.totals).toEqual({ inBackup: 4, toCreate: 3, alreadyExist: 1 });
    expect(preview.containers).toEqual([
      { id: 'books', inBackup: 3, toCreate: 2, alreadyExist: 1, containerMissing: false },
      { id: 'maps', inBackup: 1, toCreate: 1, alreadyExist: 0, containerMissing: true },
    ]);
    expect(fake.container('books').all()).toHaveLength(1);
    expect(createContainerIfMissing).not.toHaveBeenCalled();
  });

  it('inserts missing documents and never overwrites existing ones', async () => {
    const run = startRestore('backups/x.zip', 'admin@example.com');
    expect(run?.status).toBe('running');
    expect(startRestore('backups/x.zip', 'admin@example.com')).toBeNull(); // one at a time
    await waitForRestore();

    const done = getRestoreRun()!;
    expect(done).toMatchObject({ status: 'succeeded', created: 3, skipped: 1 });
    expect(fake.container('books').get('b1')).toEqual({ id: 'b1', title: 'Edited after the backup' });
    expect(fake.container('books').get('b2')).toEqual({ id: 'b2', title: 'Deleted since' });
    expect(fake.container('maps').get('m1')).toEqual({ id: 'm1', name: 'Map' });
    expect(createContainerIfMissing).toHaveBeenCalledWith(expect.objectContaining({ id: 'maps' }));
  });

  it('reports a failure', async () => {
    (downloadBlobStreamRaw as jest.Mock).mockRejectedValueOnce(new Error('blob gone'));
    startRestore('backups/x.zip', 'admin@example.com');
    await waitForRestore();
    expect(getRestoreRun()).toMatchObject({ status: 'failed', error: 'blob gone' });
  });
});
