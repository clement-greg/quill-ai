import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { uploadFileToBlob } from './storage';
import config from './config';

export type ImageProvider = 'gpt' | 'gemini';

/**
 * Generates an image from a text prompt, stores the original PNG and a WebP
 * thumbnail in blob storage, and returns their URLs. Supports Azure Foundry
 * (GPT image) and Google AI Studio (Gemini) providers.
 *
 * Throws on API failure so callers can translate to an appropriate response.
 */
export async function generateImage(
  prompt: string,
  provider: ImageProvider = 'gpt',
): Promise<{ url: string; thumbnailUrl: string }> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('prompt is required');

  let imageBuffer: Buffer;

  if (provider === 'gemini') {
    // Google AI Studio — Gemini image generation via generateContent
    const modelId = config.googleAIStudio.model;
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.googleAIStudio.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: trimmed }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini image generation API error:', errText);
      throw new Error('Image generation failed');
    }

    const geminiData = await geminiRes.json() as {
      candidates: { content: { parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] } }[]
    };

    const parts = geminiData.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find(p => p.inlineData);
    if (!imagePart?.inlineData) {
      throw new Error('No image returned from Gemini API');
    }

    imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
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
