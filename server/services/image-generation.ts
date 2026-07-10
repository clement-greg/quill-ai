import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { uploadFileToBlob } from './storage';
import config from '../config';

/** An optional source image used to keep the same face/body in the generated image. */
export interface ReferenceImage {
  data: Buffer;
  mimeType: string;
}

/**
 * Generates an image from a text prompt using Azure Foundry (GPT image), stores
 * the original PNG and a WebP thumbnail in blob storage, and returns their URLs.
 *
 * When a reference image is supplied, it is passed to the model via the Azure
 * `/images/edits` endpoint so the new image keeps the same face/body.
 *
 * Throws on API failure so callers can translate to an appropriate response.
 */
export async function generateImage(
  prompt: string,
  referenceImage?: ReferenceImage,
  options: { transparentBackground?: boolean } = {},
): Promise<{ url: string; thumbnailUrl: string }> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('prompt is required');

  let imageBuffer: Buffer;

  if (referenceImage) {
    // Azure Foundry — GPT image edit: multipart upload of the reference image.
    // The edits route requires a recent preview api-version, so override whatever
    // version the generations endpoint is pinned to.
    const editsUrl = new URL(
      config.foundry.imageGenerationEndpoint.replace('/images/generations', '/images/edits'),
    );
    editsUrl.searchParams.set('api-version', '2025-04-01-preview');
    const editsEndpoint = editsUrl.toString();

    // The edits endpoint only accepts PNG/JPEG/WebP. Stamps may be SVGs (or any
    // other format), so rasterize anything unsupported to PNG first.
    const SUPPORTED = ['image/png', 'image/jpeg', 'image/webp'];
    let refData = referenceImage.data;
    let refMime = referenceImage.mimeType || 'image/png';
    if (!SUPPORTED.includes(refMime)) {
      refData = await sharp(refData).png().toBuffer();
      refMime = 'image/png';
    }

    const form = new FormData();
    form.append('prompt', trimmed);
    form.append('n', '1');
    form.append('size', '1024x1024');
    if (options.transparentBackground) form.append('background', 'transparent');
    form.append(
      'image',
      new Blob([new Uint8Array(refData)], { type: refMime }),
      'reference.png',
    );

    const editRes = await fetch(editsEndpoint, {
      method: 'POST',
      headers: { 'api-key': config.foundry.imageGenerationKey },
      body: form,
    });

    if (!editRes.ok) {
      const errText = await editRes.text();
      console.error('Image edit API error:', errText);
      throw new Error('Image generation failed');
    }

    const editData = await editRes.json() as { data: { b64_json?: string; url?: string }[] };
    const item = editData.data?.[0];

    if (item?.b64_json) {
      imageBuffer = Buffer.from(item.b64_json, 'base64');
    } else if (item?.url) {
      const imgRes = await fetch(item.url);
      imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error('No image returned from edit API');
    }
  } else {
    // Azure Foundry — GPT image generation
    const genRes = await fetch(config.foundry.imageGenerationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': config.foundry.imageGenerationKey,
      },
      body: JSON.stringify({
        prompt: trimmed,
        n: 1,
        size: '1024x1024',
        ...(options.transparentBackground ? { background: 'transparent' } : {}),
      }),
    });

    if (!genRes.ok) {
      const errText = await genRes.text();
      console.error('Image generation API error:', errText);
      throw new Error('Image generation failed');
    }

    const genData = await genRes.json() as { data: { b64_json?: string; url?: string }[] };
    const item = genData.data?.[0];

    if (item?.b64_json) {
      imageBuffer = Buffer.from(item.b64_json, 'base64');
    } else if (item?.url) {
      const imgRes = await fetch(item.url);
      imageBuffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      throw new Error('No image returned from generation API');
    }
  }

  const id = uuidv4();
  const originalFilename = `${id}.png`;
  const thumbnailFilename = `${id}_thumb.webp`;

  const thumbnailBuffer = await sharp(imageBuffer)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();

  const [url, thumbnailUrl] = await Promise.all([
    uploadFileToBlob(imageBuffer, originalFilename, 'image/png'),
    uploadFileToBlob(thumbnailBuffer, thumbnailFilename, 'image/webp'),
  ]);

  return { url, thumbnailUrl };
}
