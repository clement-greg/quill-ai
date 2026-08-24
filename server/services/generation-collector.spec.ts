import crypto from 'crypto';

jest.mock('uuid', () => {
  let n = 0;
  return { v4: () => `gen-${++n}` };
});

/** The blob id sharp/storage was given, e.g. 'gen-4' from 'gen-4_thumb.webp'. */
function stemOf(filename: string): string {
  return filename.replace(/(_thumb)?\.[^.]+$/, '');
}

jest.mock('../config', () => ({
  __esModule: true,
  default: {
    photoExportUrl: 'https://receiver.test/',
    cryptoKey: '11'.repeat(32),
  },
}));

jest.mock('./cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

const stored: { filename: string; contentType: string; bytes: number }[] = [];
jest.mock('./storage', () => ({
  uploadFileToBlob: jest.fn(async (buffer: Buffer, filename: string, contentType: string) => {
    stored.push({ filename, contentType, bytes: buffer.length });
    return `https://blob.test/${filename}`;
  }),
}));

import sharp from 'sharp';
import { collectJob, collectOnce } from './generation-collector';
import { FakeCosmos } from '../testing/fake-cosmos';
import { TrackedGenerationJob } from '../../shared/models/generation-job.model';

const fake = jest.requireMock('./cosmos').__fake as FakeCosmos;
const KEY = Buffer.from('11'.repeat(32), 'hex');
const OWNER = 'a@example.com';

/** Wraps bytes the way the receiver does: [IV 12][tag 16][ciphertext]. */
function envelope(plaintext: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 24, channels: 3, background: '#204080' } })
    .png()
    .toBuffer();
}

let fetchMock: jest.Mock;
const realFetch = global.fetch;

function seedJob(overrides: Partial<TrackedGenerationJob> = {}): TrackedGenerationJob {
  const job: TrackedGenerationJob = {
    id: 'job-1',
    kind: 'images',
    entityId: 'e-a',
    state: 'pending',
    queuedAt: new Date().toISOString(),
    attempts: 0,
    owner: OWNER,
    ...overrides,
  };
  fake.container('generation-jobs').seed(job as never);
  return job;
}

function job(id = 'job-1'): any {
  return fake.container('generation-jobs').get(id);
}

function entity(id = 'e-a'): any {
  return fake.container('entities').get(id);
}

beforeEach(() => {
  stored.length = 0;
  fake.reset();
  fake.container('entities').seed({
    id: 'e-a',
    name: 'Arthur',
    type: 'PERSON',
    seriesId: 's-a',
    owner: OWNER,
    photos: [{ url: 'https://blob.test/existing.jpg', thumbnailUrl: 'https://blob.test/existing_thumb.webp' }],
  });
  fetchMock = jest.fn();
  global.fetch = fetchMock as never;
});

afterAll(() => {
  global.fetch = realFetch;
});

/** The receiver's answer to GET /result?all=1 with one PNG in it. */
async function readyWithOnePng() {
  return new Response(
    JSON.stringify({
      prompt_id: 'job-1',
      state: 'success',
      files: [
        {
          filename: 'Quill_00001_.png',
          content_type: 'image/png',
          data_base64: envelope(await png()),
        },
      ],
    }),
    { status: 200 }
  );
}

describe('generation collector', () => {
  it('stores a finished image and attaches it to the entity, hidden', async () => {
    seedJob();
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
      return readyWithOnePng();
    });

    await collectOnce();

    // Original plus the webp thumbnail the gallery expects alongside it, both
    // under the one blob id.
    expect(stored).toHaveLength(2);
    const stem = stemOf(stored[0].filename);
    expect(stored.map(s => s.filename)).toEqual([`${stem}.png`, `${stem}_thumb.webp`]);

    const photos = entity().photos;
    expect(photos).toHaveLength(2);
    expect(photos[1]).toEqual({
      url: `https://blob.test/${stem}.png`,
      thumbnailUrl: `https://blob.test/${stem}_thumb.webp`,
      // The private flag: generated media arrives out of sight.
      hidden: true,
    });

    expect(job()).toEqual(
      expect.objectContaining({
        state: 'collected',
        collectedAt: expect.any(String),
        assets: [expect.objectContaining({ sourceFilename: 'Quill_00001_.png' })],
      })
    );
  });

  it('tells the receiver to release the outputs once they are safely stored', async () => {
    seedJob();
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'DELETE' ? new Response('{}', { status: 200 }) : readyWithOnePng()
    );

    await collectOnce();

    const release = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(release).toBeDefined();
    expect(String(release![0])).toContain('prompt_id=job-1');
  });

  it('stores a finished video as one blob and reuses it as the thumbnail', async () => {
    seedJob({ kind: 'video' });
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
      return new Response(
        JSON.stringify({
          files: [
            { filename: 'Quill_00002_.mp4', content_type: 'video/mp4', data_base64: envelope(Buffer.from('fake-mp4')) },
          ],
        }),
        { status: 200 }
      );
    });

    await collectOnce();

    // One blob only — sharp cannot make a poster frame for a video.
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      filename: `${stemOf(stored[0].filename)}.mp4`,
      contentType: 'video/mp4',
      bytes: 8,
    });
    const photo = entity().photos[1];
    expect(photo.url).toBe(`https://blob.test/${stored[0].filename}`);
    expect(photo.thumbnailUrl).toBe(photo.url);
    expect(photo.hidden).toBe(true);
  });

  it('leaves a job that is still running alone', async () => {
    seedJob();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ state: 'running', ready: false }), { status: 202 })
    );

    await collectOnce();

    expect(job()).toEqual(expect.objectContaining({ state: 'pending', attempts: 0 }));
    expect(entity().photos).toHaveLength(1);
  });

  it('marks a job that produced no output as failed', async () => {
    seedJob();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ files: [], error: 'the job produced no output files' }), { status: 404 })
    );

    await collectOnce();

    expect(job()).toEqual(
      expect.objectContaining({ state: 'failed', lastError: 'the job produced no output files' })
    );
  });

  it('writes off a job the receiver has never heard of, but only after a few tries', async () => {
    seedJob();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ state: 'unknown', error: 'no such job in history or queue' }), { status: 404 })
    );

    await collectOnce();
    expect(job()).toEqual(expect.objectContaining({ state: 'pending', attempts: 1 }));

    await collectOnce();
    expect(job()).toEqual(expect.objectContaining({ state: 'pending', attempts: 2 }));

    await collectOnce();
    expect(job()).toEqual(expect.objectContaining({ state: 'gone', attempts: 3 }));
  });

  it('keeps a job pending when the receiver cannot be reached', async () => {
    seedJob();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await collectOnce();

    expect(job()).toEqual(expect.objectContaining({ state: 'pending', attempts: 1 }));
    expect(job().lastError).toContain('could not reach the receiver');
  });

  it('does not download twice when only the attach failed', async () => {
    // A job left in `stored` is one whose files are down but unattached.
    seedJob({
      state: 'stored',
      assets: [
        {
          url: 'https://blob.test/gen-earlier.png',
          thumbnailUrl: 'https://blob.test/gen-earlier_thumb.webp',
          sourceFilename: 'Quill_00003_.png',
        },
      ],
    });
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) =>
      init?.method === 'DELETE' ? new Response('{}', { status: 200 }) : readyWithOnePng()
    );

    await collectOnce();

    // Nothing was re-stored; the recorded urls were attached as they were.
    expect(stored).toEqual([]);
    expect(entity().photos[1].url).toBe('https://blob.test/gen-earlier.png');
    expect(job().state).toBe('collected');
    // And it never asked the receiver for the result again.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== 'DELETE')).toEqual([]);
  });

  it('attaches an asset once even if the attach step runs twice', async () => {
    const asset = {
      url: 'https://blob.test/gen-twice.png',
      thumbnailUrl: 'https://blob.test/gen-twice_thumb.webp',
      sourceFilename: 'Quill_00004_.png',
    };
    const first = seedJob({ state: 'stored', assets: [asset] });
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await collectJob(first);
    // Re-run the same attach against the state it left behind.
    await collectJob({ ...first, state: 'stored' });

    expect(entity().photos.filter((p: any) => p.url === asset.url)).toHaveLength(1);
  });

  it('refuses to attach to an entity that has changed hands', async () => {
    seedJob({
      state: 'stored',
      assets: [{ url: 'https://blob.test/x.png', thumbnailUrl: 'https://blob.test/x_thumb.webp', sourceFilename: 'x.png' }],
    });
    fake.container('entities').seed({ id: 'e-a', name: 'Arthur', owner: 'someone-else@example.com' } as never);
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await collectOnce();

    expect(entity().photos).toBeUndefined();
    expect(job().state).toBe('stored');
    expect(job().lastError).toContain('no longer owned');
  });

  it('does not let one broken job stop the others', async () => {
    seedJob({ id: 'job-bad' });
    seedJob({ id: 'job-good' });
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
      if (String(url).includes('job-bad')) throw new Error('kaboom');
      return readyWithOnePng();
    });

    await collectOnce();

    expect(job('job-good').state).toBe('collected');
    expect(entity().photos).toHaveLength(2);
  });
});
