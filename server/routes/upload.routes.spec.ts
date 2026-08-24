import request from 'supertest';
import sharp from 'sharp';

// The uuid package ships ESM only, which this Jest setup can't load.
jest.mock('uuid', () => ({ v4: () => 'fixed-id' }));

const uploaded: { filename: string; contentType: string; bytes: number }[] = [];

jest.mock('../config', () => ({
  __esModule: true,
  default: { photoExportUrl: 'https://receiver.test/' },
}));

jest.mock('../services/storage', () => ({
  uploadFileToBlob: jest.fn(async (buffer: Buffer, filename: string, contentType: string) => {
    uploaded.push({ filename, contentType, bytes: buffer.length });
    return `https://blob.test/${filename}`;
  }),
  // Raw = the stored ciphertext. The video relay must send this untouched, so the
  // mock deliberately offers no decrypting counterpart to reach for.
  downloadBlobRaw: jest.fn(async (filename: string) => {
    if (filename === 'missing.jpg') throw Object.assign(new Error('nope'), { statusCode: 404 });
    return { raw: Buffer.from('stored-ciphertext'), contentType: 'image/jpeg' };
  }),
}));

// The generate routes look the target entity up, and track the job they queue.
// A fake Cosmos stands in for both, so the relay can be tested without a
// database — the collector itself is exercised in generation-collector.spec.ts.
jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import uploadRoutes from './upload.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/upload', uploadRoutes);

beforeEach(() => {
  uploaded.length = 0;
  fake.reset();
  fake.container('entities').seed(
    { id: 'e-a', name: 'Arthur', type: 'PERSON', seriesId: 's-a', owner: USER_A },
    { id: 'e-b', name: 'Bobette', type: 'PERSON', seriesId: 's-b', owner: USER_B },
  );
});

/** The tracked-job records the routes wrote, for asserting on what was queued. */
function trackedJobs(): any[] {
  return fake.container('generation-jobs').all();
}

async function jpeg(): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 40, channels: 3, background: '#c05028' } })
    .jpeg()
    .toBuffer();
}

async function heic(): Promise<Buffer> {
  return sharp({ create: { width: 60, height: 40, channels: 3, background: '#c05028' } })
    .heif({ compression: 'av1' })
    .toBuffer();
}

describe('upload routes', () => {
  it('stores a plain JPEG untouched alongside a webp thumbnail', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('x-test-user', USER_A)
      .attach('file', await jpeg(), { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.jpg$/);
    expect(res.body.thumbnailUrl).toMatch(/_thumb\.webp$/);
  });

  it('accepts a HEIC library photo and transcodes it to JPEG', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('x-test-user', USER_A)
      .attach('file', await heic(), { filename: 'IMG_0421.HEIC', contentType: 'image/heic' });

    expect(res.status).toBe(200);
    // Stored as .jpg — only Safari can render HEIC, so the original is converted.
    expect(res.body.url).toMatch(/\.jpg$/);
    const original = uploaded.find(u => u.filename.endsWith('.jpg'));
    expect(original?.contentType).toBe('image/jpeg');
  });

  it('accepts a photo whose filename carries no extension, naming it from the MIME type', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('x-test-user', USER_A)
      .attach('file', await jpeg(), { filename: 'image', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.jpg$/);
  });

  it('keeps a video extension so the gallery can still tell it from a photo', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('x-test-user', USER_A)
      .attach('file', Buffer.from('not really a movie'), {
        filename: 'clip',
        contentType: 'video/quicktime',
      });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.mov$/);
    expect(res.body.thumbnailUrl).toBe(res.body.url);
    expect(uploaded[0].contentType).toBe('video/quicktime');
  });

  it('rejects a non-media file with a readable JSON message', async () => {
    const res = await request(app)
      .post('/api/upload')
      .set('x-test-user', USER_A)
      .attach('file', Buffer.from('%PDF-1.4'), {
        filename: 'notes.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image and video/i);
  });
});

describe('video generation', () => {
  const realFetch = global.fetch;
  let calls: { url: string; init: any }[];

  const JOB = '{"prompt_id":"job-1","seed":42,"queue_number":3}';

  function post(body: any) {
    return request(app)
      .post('/api/upload/generate-video')
      .set('x-test-user', USER_A)
      .send(body);
  }

  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JOB, { status: 200 });
    }) as any;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('sends the stored bytes and the prompt, and returns the queued job', async () => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: '  he turns and smiles  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ promptId: 'job-1', seed: 42, queueNumber: 3, frames: null, tracked: false });
    expect(calls).toHaveLength(1);

    const target = new URL(calls[0].url);
    expect(target.origin + target.pathname).toBe('https://receiver.test/generate');
    // The prompt is trimmed before it goes out.
    expect(target.searchParams.get('prompt')).toBe('he turns and smiles');
    expect(target.searchParams.get('name')).toBe('abc-123.jpg');
    expect(calls[0].init.headers['Content-Type']).toBe('image/jpeg');
    // Sent exactly as stored — decrypting is the receiver's job.
    expect(Buffer.from(calls[0].init.body).toString()).toBe('stored-ciphertext');
  });

  it.each([
    [0.5, 9],
    [1, 17],
    [2.5, 41],
    [5, 81],
    [8, 129],
  ])('turns %ss into %s frames — always a 4n+1 count Wan accepts', async (seconds, frames) => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left', durationSeconds: seconds });

    expect(res.status).toBe(200);
    expect(res.body.frames).toBe(frames);
    expect((frames - 1) % 4).toBe(0);
    expect(new URL(calls[0].url).searchParams.get('length')).toBe(String(frames));
  });

  it('omits length entirely when no duration is asked for, leaving the workflow default', async () => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

    expect(res.status).toBe(200);
    expect(res.body.frames).toBeNull();
    expect(new URL(calls[0].url).searchParams.has('length')).toBe(false);
  });

  it.each([0, 0.2, 8.5, 100, 'soon'])('refuses an out-of-range duration (%s)', async (seconds) => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left', durationSeconds: seconds });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Duration must be/);
    expect(calls).toHaveLength(0);
  });

  it('escapes a prompt that would otherwise break the query string', async () => {
    await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'zoom & pan?name=evil.jpg' });

    const target = new URL(calls[0].url);
    expect(target.searchParams.get('prompt')).toBe('zoom & pan?name=evil.jpg');
    expect(target.searchParams.get('name')).toBe('abc-123.jpg');
  });

  it('requires a prompt', async () => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a prompt beyond the length limit', async () => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'x'.repeat(2001) });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2000 characters/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a video as the start frame', async () => {
    const res = await post({ url: 'https://blob.test/clip.mov', prompt: 'pan left' });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('refuses a url that tries to walk out of the container', async () => {
    const res = await post({ url: '..%2F..%2Fetc%2Fpasswd', prompt: 'pan left' });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("passes the receiver's own reason through so the UI can show it", async () => {
    global.fetch = jest.fn(async () => new Response(
      '{"error":"cannot reach ComfyUI at http://127.0.0.1:8188 (refused)"}',
      { status: 400 }
    )) as any;

    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/cannot reach ComfyUI/);
  });

  it('falls back to the status when the receiver sends no readable reason', async () => {
    global.fetch = jest.fn(async () => new Response('<html>gateway</html>', { status: 500 })) as any;

    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Receiver returned 500/);
  });

  it('reports a sign-in redirect from the tunnel as a failure', async () => {
    global.fetch = jest.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://tunnels.example/auth' },
    })) as any;

    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/sign-in/i);
  });

  describe('when the remote machine misbehaves', () => {
    /** Node wraps socket failures in a TypeError carrying the real code in `cause`. */
    function socketError(code: string) {
      const err = new TypeError('fetch failed');
      (err as any).cause = Object.assign(new Error(code), { code });
      return err;
    }

    it.each([
      ['ECONNREFUSED', 502, /refused the connection/i],
      ['ENOTFOUND', 502, /cannot find the receiver/i],
      ['EAI_AGAIN', 502, /cannot find the receiver/i],
      ['ETIMEDOUT', 504, /timed out connecting/i],
      ['ECONNRESET', 502, /dropped mid-request/i],
      ['EPIPE', 502, /dropped mid-request/i],
    ])('names %s as its own problem', async (code, status, message) => {
      global.fetch = jest.fn(async () => {
        throw socketError(code);
      }) as any;

      const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

      expect(res.status).toBe(status);
      expect(res.body.error).toMatch(message);
    });

    it('warns that a timed-out job may still have been queued', async () => {
      global.fetch = jest.fn(async () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      }) as any;

      const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

      expect(res.status).toBe(504);
      // Aborting our request does not cancel the far side, so the message must
      // not claim the job failed outright.
      expect(res.body.error).toMatch(/may still have been queued/i);
    });

    it('gives up on the receiver rather than hanging forever', async () => {
      let signal: AbortSignal | undefined;
      global.fetch = jest.fn(async (_url: any, init: any) => {
        signal = init.signal;
        return new Response(JOB, { status: 200 });
      }) as any;

      await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('reports a genuinely dead receiver, through real fetch', async () => {
      // No mock here: this proves the mapping matches what undici actually
      // throws, not just what the other tests pretend it throws.
      global.fetch = realFetch;
      const cfg = require('../config').default;
      const original = cfg.photoExportUrl;
      cfg.photoExportUrl = 'http://127.0.0.1:59321';
      try {
        const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/refused the connection/i);
      } finally {
        cfg.photoExportUrl = original;
      }
    });

    it('still reports an unrecognised failure with whatever detail it has', async () => {
      global.fetch = jest.fn(async () => {
        throw socketError('UND_ERR_WEIRD');
      }) as any;

      const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/UND_ERR_WEIRD/);
    });

    it('blames storage, not the receiver, when the photo cannot be read', async () => {
      const storage = require('../services/storage');
      storage.downloadBlobRaw.mockImplementationOnce(async () => {
        throw new Error('container offline');
      });

      const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/from storage/i);
      expect(calls).toHaveLength(0);
    });
  });

  it('says so when no receiver is configured', async () => {
    const cfg = require('../config').default;
    const original = cfg.photoExportUrl;
    cfg.photoExportUrl = '';
    try {
      const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'pan left' });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/photoExportUrl/);
      expect(calls).toHaveLength(0);
    } finally {
      cfg.photoExportUrl = original;
    }
  });

  it('reports a missing blob as a 404', async () => {
    const res = await post({ url: 'https://blob.test/missing.jpg', prompt: 'pan left' });

    expect(res.status).toBe(404);
  });
});


describe('image generation', () => {
  const realFetch = global.fetch;
  let calls: { url: string; init: any }[];

  const JOB = '{"prompt_id":"job-9","seed":7,"queue_number":1}';

  function post(body: any) {
    return request(app)
      .post('/api/upload/generate-images')
      .set('x-test-user', USER_A)
      .send(body);
  }

  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JOB, { status: 200 });
    }) as any;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('sends the stored bytes to /faceid and defaults to three images', async () => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: '  in dress uniform  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ promptId: 'job-9', seed: 7, queueNumber: 1, count: 3, tracked: false });

    const target = new URL(calls[0].url);
    expect(target.origin + target.pathname).toBe('https://receiver.test/faceid');
    expect(target.searchParams.get('prompt')).toBe('in dress uniform');
    expect(target.searchParams.get('name')).toBe('abc-123.jpg');
    expect(target.searchParams.get('batch_size')).toBe('3');
    // Sent exactly as stored — decrypting is the receiver's job.
    expect(Buffer.from(calls[0].init.body).toString()).toBe('stored-ciphertext');
  });

  it(`passes the advanced settings through under the receiver's own names`, async () => {
    const res = await post({
      url: 'https://blob.test/abc-123.jpg',
      prompt: 'on a parade ground',
      count: 6,
      negativePrompt: 'blurry, watermark',
      width: 768,
      height: 1024,
      steps: 30,
      cfg: 4.5,
      seed: 12345,
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(6);

    const q = new URL(calls[0].url).searchParams;
    expect(q.get('batch_size')).toBe('6');
    expect(q.get('negative_prompt')).toBe('blurry, watermark');
    expect(q.get('width')).toBe('768');
    expect(q.get('height')).toBe('1024');
    expect(q.get('steps')).toBe('30');
    expect(q.get('cfg')).toBe('4.5');
    expect(q.get('seed')).toBe('12345');
  });

  it('leaves out every setting that was not asked for', async () => {
    await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'portrait', negativePrompt: '   ' });

    const q = new URL(calls[0].url).searchParams;
    for (const param of ['negative_prompt', 'width', 'height', 'steps', 'cfg', 'seed']) {
      expect(q.has(param)).toBe(false);
    }
  });

  it.each([0, 13, 2.5, 'lots'])('refuses an out-of-range image count (%s)', async (count) => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'portrait', count });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 12/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['width', 32],
    ['height', 4000],
    ['steps', 0],
    ['cfg', 99],
    ['seed', -1],
  ])('refuses an out-of-range %s', async (field, value) => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'portrait', [field]: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(`${field} must be between`));
    expect(calls).toHaveLength(0);
  });

  it('requires a prompt', async () => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt is required/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a video as the reference photo', async () => {
    const res = await post({ url: 'https://blob.test/clip.mov', prompt: 'portrait' });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('says so when the photo is gone from storage', async () => {
    const res = await post({ url: 'https://blob.test/missing.jpg', prompt: 'portrait' });

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("passes the receiver's own reason through so the UI can show it", async () => {
    global.fetch = jest.fn(async () => new Response('{"error":"FaceID model missing"}', { status: 400 })) as any;

    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: 'portrait' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/FaceID model missing/);
  });
});


describe('generation queue', () => {
  const realFetch = global.fetch;
  let calls: { url: string; init: any }[];

  /** A queue as the receiver reports it: one job running, one waiting. */
  const QUEUE = JSON.stringify({
    counts: { running: 1, pending: 1, total: 2 },
    running: [
      {
        prompt_id: 'job-1',
        queue_number: 7,
        start_image: 'start-abc.jpg',
        prompt: 'he turns and smiles',
        mine: true,
        queued_at: '2026-08-21T10:00:00Z',
        started_at: '2026-08-21T10:00:05Z',
        elapsed_seconds: 30.5,
        percent_complete: 25.0,
        estimated_total_seconds: 120,
        eta_seconds: 90,
        settings: { width: 832, height: 480, length: 81, fps: 16, steps: 6, seed: 42 },
        progress_source: 'websocket',
        progress: {
          source: 'websocket',
          percent_complete: 25.0,
          steps_done: 5,
          steps_total: 20,
          updated_seconds_ago: 1.2,
          current_node: { id: '57', class_type: 'KSamplerAdvanced', value: 5, max: 10 },
        },
      },
    ],
    pending: [
      {
        prompt_id: 'job-2',
        queue_number: 8,
        mine: false,
        position: 1,
        estimated_total_seconds: 100,
        starts_in_seconds: 90,
        eta_seconds: 190,
        settings: { batch_size: 4, cfg: 7.5 },
      },
    ],
    queue: { percent_complete: 13.6, estimated_seconds_remaining: 190, idle: false },
    estimate_basis: { seconds_per_frame: 1.48, measured: true, note: 'measured' },
    progress_feed: { connected: true, client_id: 'abc', messages: 42, error: null, note: 'live' },
  });

  function getQueue() {
    return request(app).get('/api/upload/generation-queue').set('x-test-user', USER_A);
  }

  function cancel(promptId: string) {
    return request(app)
      .delete(`/api/upload/generation-queue/${promptId}`)
      .set('x-test-user', USER_A);
  }

  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(QUEUE, { status: 200 });
    }) as any;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it("reads the receiver's queue and flattens it, running job first", async () => {
    const res = await getQueue();

    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://receiver.test/queue');
    expect(res.body.counts).toEqual({ running: 1, pending: 1, total: 2 });
    expect(res.body.jobs.map((j: any) => [j.promptId, j.state])).toEqual([
      ['job-1', 'running'],
      ['job-2', 'pending'],
    ]);
    expect(res.body.queue).toEqual({
      percentComplete: 13.6,
      estimatedSecondsRemaining: 190,
      idle: false,
    });
  });

  it('hands the UI camelCase progress and settings', async () => {
    const res = await getQueue();

    const [running, pending] = res.body.jobs;
    expect(running).toMatchObject({
      queueNumber: 7,
      startImage: 'start-abc.jpg',
      mine: true,
      startedAt: '2026-08-21T10:00:05Z',
      elapsedSeconds: 30.5,
      percentComplete: 25,
      etaSeconds: 90,
      position: null,
    });
    expect(running.settings).toEqual({
      width: 832, height: 480, length: 81, fps: 16, steps: 6, seed: 42,
    });
    expect(pending).toMatchObject({ position: 1, startsInSeconds: 90, mine: false });
    // The prompt the receiver echoes back is deliberately not relayed to the UI.
    expect(running).not.toHaveProperty('prompt');
    expect(pending).not.toHaveProperty('prompt');
    expect(pending.settings).toEqual({ batchSize: 4, cfg: 7.5 });
  });

  it('carries the step-level progress of the running job through', async () => {
    const res = await getQueue();

    const [running, pending] = res.body.jobs;
    expect(running.progressSource).toBe('websocket');
    expect(running.progress).toEqual({
      source: 'websocket',
      percentComplete: 25,
      stepsDone: 5,
      stepsTotal: 20,
      updatedSecondsAgo: 1.2,
      currentNode: { id: '57', classType: 'KSamplerAdvanced', value: 5, max: 10 },
    });
    // A pending job has nothing executing, so it has neither.
    expect(pending.progress).toBeNull();
    expect(pending.progressSource).toBeNull();
    expect(res.body.progressFeed).toEqual({
      connected: true,
      messages: 42,
      error: null,
      note: 'live',
    });
  });

  it('reports no progress for a job the websocket feed knows nothing about', async () => {
    // What a job queued by another client looks like: ComfyUI addresses its
    // progress messages elsewhere, so the receiver has no step counts for it.
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      counts: { running: 1, pending: 0, total: 1 },
      running: [{ prompt_id: 'other-1', progress_source: 'unknown', settings: { steps: 20 } }],
      pending: [],
      queue: { percent_complete: 0, estimated_seconds_remaining: 600, idle: false },
      progress_feed: { connected: false, messages: 0, error: 'connection refused', note: 'offline' },
    }), { status: 200 })) as any;

    const res = await getQueue();

    const [job] = res.body.jobs;
    expect(job.progress).toBeNull();
    expect(job.progressSource).toBe('unknown');
    expect(job.percentComplete).toBeNull();
    expect(res.body.progressFeed).toMatchObject({ connected: false, error: 'connection refused' });
  });

  it('ignores a progress block with no step total to divide by', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      counts: { running: 1, pending: 0, total: 1 },
      running: [{
        prompt_id: 'job-1',
        progress_source: 'websocket',
        progress: { source: 'websocket', percent_complete: 0, steps_done: 0, steps_total: 0 },
      }],
      pending: [],
      queue: { percent_complete: 0, estimated_seconds_remaining: 0, idle: false },
    }), { status: 200 })) as any;

    const res = await getQueue();

    expect(res.body.jobs[0].progress).toBeNull();
  });

  it('reports an empty queue as idle', async () => {
    global.fetch = jest.fn(async () => new Response(
      '{"counts":{"running":0,"pending":0,"total":0},"running":[],"pending":[],'
      + '"queue":{"percent_complete":100.0,"estimated_seconds_remaining":0,"idle":true}}',
      { status: 200 },
    )) as any;

    const res = await getQueue();

    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.queue.idle).toBe(true);
  });

  it('cancels one job by prompt id', async () => {
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(
        '{"prompt_id":"job-1","cancelled":true,"action":"interrupted mid-run"}',
        { status: 200 },
      );
    }) as any;

    const res = await cancel('job-1');

    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://receiver.test/cancel?prompt_id=job-1');
    expect(calls[0].init.method).toBe('POST');
    expect(res.body).toEqual({
      promptId: 'job-1',
      cancelled: true,
      action: 'interrupted mid-run',
    });
  });

  it("passes through the receiver's verdict that a job already finished", async () => {
    global.fetch = jest.fn(async () => new Response(
      '{"cancelled":false,"error":"job already finished -- nothing to cancel"}',
      { status: 409 },
    )) as any;

    const res = await cancel('job-1');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already finished/);
  });

  it('passes through an unknown job as a 404', async () => {
    global.fetch = jest.fn(async () => new Response(
      '{"error":"no such job in the queue or history"}',
      { status: 404 },
    )) as any;

    const res = await cancel('job-9');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no such job/);
  });

  it('refuses a prompt id that never came from a queue listing', async () => {
    const res = await cancel('..%2F..%2Fqueue');

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('reports an unreachable receiver rather than an empty queue', async () => {
    global.fetch = jest.fn(async () => {
      const err = new TypeError('fetch failed');
      (err as any).cause = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      throw err;
    }) as any;

    const res = await getQueue();

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/refused the connection/i);
  });

  it('says so when no receiver is configured', async () => {
    const cfg = require('../config').default;
    const original = cfg.photoExportUrl;
    cfg.photoExportUrl = '';
    try {
      expect((await getQueue()).status).toBe(503);
      expect((await cancel('job-1')).status).toBe(503);
      expect(calls).toHaveLength(0);
    } finally {
      cfg.photoExportUrl = original;
    }
  });
});

describe('job tracking', () => {
  const realFetch = global.fetch;
  const JOB = '{"prompt_id":"job-track","seed":5,"queue_number":2}';

  beforeAll(() => {
    global.fetch = jest.fn(async () => new Response(JOB, { status: 200 })) as any;
  });

  beforeEach(() => {
    (global.fetch as jest.Mock).mockClear();
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('records a video job against the entity it was started from', async () => {
    const res = await request(app)
      .post('/api/upload/generate-video')
      .set('x-test-user', USER_A)
      .send({ url: 'https://blob.test/abc-123.jpg', prompt: 'he turns', durationSeconds: 5, entityId: 'e-a' });

    expect(res.status).toBe(200);
    expect(res.body.tracked).toBe(true);

    expect(trackedJobs()).toEqual([
      expect.objectContaining({
        id: 'job-track',
        kind: 'video',
        entityId: 'e-a',
        entityName: 'Arthur',
        seriesId: 's-a',
        state: 'pending',
        startImage: 'abc-123.jpg',
        // 5s at 16fps is 80 frames, snapped up to the nearest 4n+1.
        frames: 81,
        attempts: 0,
        owner: USER_A,
      }),
    ]);
  });

  it('records an image job with the number of stills asked for', async () => {
    const res = await request(app)
      .post('/api/upload/generate-images')
      .set('x-test-user', USER_A)
      .send({ url: 'https://blob.test/abc-123.jpg', prompt: 'on a beach', count: 4, entityId: 'e-a' });

    expect(res.status).toBe(200);
    expect(res.body.tracked).toBe(true);
    expect(trackedJobs()[0]).toEqual(
      expect.objectContaining({ kind: 'images', requestedCount: 4, entityId: 'e-a' })
    );
  });

  it('refuses to attach a job to someone else’s entity, and queues nothing', async () => {
    const res = await request(app)
      .post('/api/upload/generate-video')
      .set('x-test-user', USER_A)
      .send({ url: 'https://blob.test/abc-123.jpg', prompt: 'he turns', entityId: 'e-b' });

    expect(res.status).toBe(404);
    expect(trackedJobs()).toEqual([]);
    // Rejected before the receiver was troubled with it.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still queues a job with no entityId, but does not track it', async () => {
    const res = await request(app)
      .post('/api/upload/generate-video')
      .set('x-test-user', USER_A)
      .send({ url: 'https://blob.test/abc-123.jpg', prompt: 'he turns' });

    expect(res.status).toBe(200);
    expect(res.body.tracked).toBe(false);
    expect(trackedJobs()).toEqual([]);
  });

  describe('GET /generation-jobs', () => {
    beforeEach(() => {
      fake.container('generation-jobs').seed(
        { id: 'j-1', kind: 'images', entityId: 'e-a', state: 'collected', owner: USER_A,
          queuedAt: '2026-01-01T00:00:00.000Z', attempts: 1 },
        { id: 'j-2', kind: 'video', entityId: 'e-a', state: 'pending', owner: USER_A,
          queuedAt: '2026-01-02T00:00:00.000Z', attempts: 0 },
        { id: 'j-3', kind: 'video', entityId: 'e-b', state: 'pending', owner: USER_B,
          queuedAt: '2026-01-03T00:00:00.000Z', attempts: 0 },
      );
    });

    it('lists the caller’s own jobs, newest first, and nobody else’s', async () => {
      const res = await request(app).get('/api/upload/generation-jobs').set('x-test-user', USER_A);
      expect(res.status).toBe(200);
      expect(res.body.jobs.map((j: any) => j.id)).toEqual(['j-2', 'j-1']);
    });

    it('scoped to an entity, returns only what is still outstanding', async () => {
      const res = await request(app)
        .get('/api/upload/generation-jobs?entityId=e-a')
        .set('x-test-user', USER_A);
      expect(res.status).toBe(200);
      // j-1 is collected, so it is no longer something to wait on.
      expect(res.body.jobs.map((j: any) => j.id)).toEqual(['j-2']);
    });

    it('dismisses one of the caller’s jobs and refuses another user’s', async () => {
      expect(
        (await request(app).delete('/api/upload/generation-jobs/j-3').set('x-test-user', USER_A)).status
      ).toBe(404);
      expect(fake.container('generation-jobs').get('j-3')).toBeDefined();

      expect(
        (await request(app).delete('/api/upload/generation-jobs/j-2').set('x-test-user', USER_A)).status
      ).toBe(204);
      expect(fake.container('generation-jobs').get('j-2')).toBeUndefined();
    });
  });
});
