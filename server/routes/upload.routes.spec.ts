import request from 'supertest';
import sharp from 'sharp';

// The uuid package ships ESM only, which this Jest setup can't load.
jest.mock('uuid', () => ({ v4: () => 'fixed-id' }));

const uploaded: { filename: string; contentType: string; bytes: number }[] = [];

jest.mock('../services/storage', () => ({
  uploadFileToBlob: jest.fn(async (buffer: Buffer, filename: string, contentType: string) => {
    uploaded.push({ filename, contentType, bytes: buffer.length });
    return `https://blob.test/${filename}`;
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
