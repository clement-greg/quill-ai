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
  downloadBlob: jest.fn(async (filename: string) => {
    if (filename === 'missing.jpg') throw Object.assign(new Error('nope'), { statusCode: 404 });
    return { data: Buffer.from('decrypted-bytes'), contentType: 'image/jpeg' };
  }),
}));

import uploadRoutes from './upload.routes';
import { makeTestApp, USER_A } from '../testing/test-app';

const app = makeTestApp('/api/upload', uploadRoutes);

beforeEach(() => {
  uploaded.length = 0;
});

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

  it('sends the decrypted bytes and the prompt, and returns the queued job', async () => {
    const res = await post({ url: 'https://blob.test/abc-123.jpg', prompt: '  he turns and smiles  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ promptId: 'job-1', seed: 42, queueNumber: 3, frames: null });
    expect(calls).toHaveLength(1);

    const target = new URL(calls[0].url);
    expect(target.origin + target.pathname).toBe('https://receiver.test/generate');
    // The prompt is trimmed before it goes out.
    expect(target.searchParams.get('prompt')).toBe('he turns and smiles');
    expect(target.searchParams.get('name')).toBe('abc-123.jpg');
    expect(calls[0].init.headers['Content-Type']).toBe('image/jpeg');
    expect(Buffer.from(calls[0].init.body).toString()).toBe('decrypted-bytes');
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
      storage.downloadBlob.mockImplementationOnce(async () => {
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
