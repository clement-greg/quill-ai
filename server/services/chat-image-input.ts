import sharp from 'sharp';
import { downloadBlob } from './storage';

/** A chat message as the client sends it: text plus the URLs of any pasted images. */
export interface IncomingChatMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
}

type InputContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' };

/** A message in the shape the Responses API accepts: plain text, or text and images. */
export type ModelChatMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'user'; content: InputContentPart[] };

/** Most images sent in one request, newest first; older ones are dropped. */
export const MAX_CHAT_IMAGES = 6;
/** Longest edge sent to the model. Large enough to keep screenshot text legible. */
export const MAX_IMAGE_EDGE = 2048;

/** Stored media blobs are named `<uuid>.<ext>`; anything else is not a chat upload. */
const BLOB_NAME = /^[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/i;

/** The blob name behind a stored-image URL, or null when it is not one. */
export function blobNameFromImageUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const name = url.split('?')[0].split('/').pop() ?? '';
  return BLOB_NAME.test(name) ? name : null;
}

/** Reads a stored image and returns it as a data URL, scaled down to fit MAX_IMAGE_EDGE. */
async function imageDataUrl(blobName: string): Promise<string> {
  const { data } = await downloadBlob(blobName);
  const image = sharp(data).rotate().resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, {
    fit: 'inside',
    withoutEnlargement: true,
  });
  // Screenshots are mostly flat colour and text, which PNG keeps sharp; photos
  // are far smaller as JPEG.
  const isPng = /\.png$/i.test(blobName);
  const out = isPng ? await image.png().toBuffer() : await image.jpeg({ quality: 85 }).toBuffer();
  return `data:${isPng ? 'image/png' : 'image/jpeg'};base64,${out.toString('base64')}`;
}

/**
 * Turns the client's messages into model input, attaching each user message's
 * pasted images as `input_image` parts. Only the newest MAX_CHAT_IMAGES images
 * are sent; one that cannot be read is skipped rather than failing the reply.
 */
export async function toModelMessages(messages: IncomingChatMessage[]): Promise<ModelChatMessage[]> {
  // Choose which images to keep, newest first, across the whole conversation.
  const keep = new Set<string>();
  for (let i = messages.length - 1; i >= 0 && keep.size < MAX_CHAT_IMAGES; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.images)) continue;
    for (let j = m.images.length - 1; j >= 0 && keep.size < MAX_CHAT_IMAGES; j--) {
      keep.add(`${i}:${j}`);
    }
  }

  return Promise.all(messages.map(async (m, i): Promise<ModelChatMessage> => {
    const text = typeof m.content === 'string' ? m.content : '';
    if (m.role !== 'user' || !Array.isArray(m.images) || m.images.length === 0) {
      return { role: m.role, content: text };
    }
    const names = m.images
      .map((url, j) => (keep.has(`${i}:${j}`) ? blobNameFromImageUrl(url) : null))
      .filter((n): n is string => !!n);
    const dataUrls = await Promise.all(names.map(n => imageDataUrl(n).catch(err => {
      console.error(`Chat image ${n} could not be read:`, err);
      return null;
    })));
    const images = dataUrls.filter((u): u is string => !!u);
    if (images.length === 0) return { role: 'user', content: text };
    return {
      role: 'user',
      content: [
        { type: 'input_text', text: text || 'Here is a screenshot.' },
        ...images.map(url => ({ type: 'input_image' as const, image_url: url, detail: 'auto' as const })),
      ],
    };
  }));
}
