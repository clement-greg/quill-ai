jest.mock('../config');
jest.mock('./storage', () => ({ downloadBlob: jest.fn() }));

import sharp from 'sharp';
import { downloadBlob } from './storage';
import { blobNameFromImageUrl, MAX_CHAT_IMAGES, toModelMessages } from './chat-image-input';

const download = downloadBlob as jest.Mock;
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const url = (n: number, ext = 'png') => `https://acct.blob.core.windows.net/media/${ID.slice(0, -1)}${n}.${ext}`;

async function pngOf(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#336699' } }).png().toBuffer();
}

beforeEach(async () => {
  download.mockReset();
  const png = await pngOf(40, 20);
  download.mockResolvedValue({ data: png, contentType: 'image/png' });
});

describe('blobNameFromImageUrl', () => {
  it('returns the uuid blob name of a stored image', () => {
    expect(blobNameFromImageUrl(`https://x/media/${ID}.png?sv=1`)).toBe(`${ID}.png`);
    expect(blobNameFromImageUrl(`/api/image/${ID}.jpeg`)).toBe(`${ID}.jpeg`);
  });

  it('rejects anything that is not a stored image', () => {
    expect(blobNameFromImageUrl('https://x/folder-files/secret.pdf')).toBeNull();
    expect(blobNameFromImageUrl(`https://x/${ID}.svg`)).toBeNull();
    expect(blobNameFromImageUrl('../../etc/passwd')).toBeNull();
    expect(blobNameFromImageUrl(42)).toBeNull();
  });
});

describe('toModelMessages', () => {
  it('passes text-only messages through unchanged', async () => {
    const out = await toModelMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(download).not.toHaveBeenCalled();
  });

  it('attaches pasted images as input_image parts with data URLs', async () => {
    const [msg] = await toModelMessages([{ role: 'user', content: 'what is wrong here?', images: [url(1)] }]);
    expect(download).toHaveBeenCalledWith(`${ID.slice(0, -1)}1.png`);
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as Array<Record<string, string>>;
    expect(parts[0]).toEqual({ type: 'input_text', text: 'what is wrong here?' });
    expect(parts[1].type).toBe('input_image');
    expect(parts[1].image_url).toMatch(/^data:image\/png;base64,/);
  });

  it('gives an image-only message placeholder text', async () => {
    const [msg] = await toModelMessages([{ role: 'user', content: '', images: [url(1)] }]);
    expect((msg.content as Array<Record<string, string>>)[0].text).toBe('Here is a screenshot.');
  });

  it('scales large images down and sends photos as JPEG', async () => {
    download.mockResolvedValue({ data: await pngOf(4000, 1000), contentType: 'image/jpeg' });
    const [msg] = await toModelMessages([{ role: 'user', content: 'x', images: [url(1, 'jpg')] }]);
    const dataUrl = (msg.content as Array<Record<string, string>>)[1].image_url;
    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    const meta = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).metadata();
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(512);
  });

  it('keeps only the newest images when there are too many', async () => {
    const older = Array.from({ length: 4 }, (_, i) => url(i));
    const newer = Array.from({ length: 4 }, (_, i) => url(i + 4));
    const out = await toModelMessages([
      { role: 'user', content: 'old', images: older },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'new', images: newer },
    ]);
    expect(download).toHaveBeenCalledTimes(MAX_CHAT_IMAGES);
    expect((out[2].content as unknown[]).length).toBe(1 + 4);
    expect((out[0].content as unknown[]).length).toBe(1 + (MAX_CHAT_IMAGES - 4));
  });

  it('skips an image it cannot read and falls back to text', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    download.mockRejectedValue(new Error('gone'));
    const [msg] = await toModelMessages([{ role: 'user', content: 'see this', images: [url(1)] }]);
    expect(msg).toEqual({ role: 'user', content: 'see this' });
  });

  it('ignores images on assistant messages and bogus URLs', async () => {
    const out = await toModelMessages([
      { role: 'assistant', content: 'a', images: [url(1)] },
      { role: 'user', content: 'b', images: ['https://evil/x.pdf'] },
    ]);
    expect(out).toEqual([
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
    expect(download).not.toHaveBeenCalled();
  });
});
