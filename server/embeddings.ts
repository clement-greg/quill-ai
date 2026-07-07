import { AzureOpenAI } from 'openai';
import config from './config';
import { sanitizeForModeration } from './content-sanitize';

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await client.embeddings.create({
    model: config.foundry.embeddingModel,
    input: await sanitizeForModeration(text),
  });
  return response.data[0].embedding;
}

/**
 * Generates embeddings for many texts in a single request. The embeddings API
 * accepts an array input and returns one vector per input, preserving order.
 * Returns an empty array if given no texts.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await client.embeddings.create({
    model: config.foundry.embeddingModel,
    input: await Promise.all(texts.map(sanitizeForModeration)),
  });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}
