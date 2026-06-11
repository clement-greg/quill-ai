import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import config from './config';
import { encrypt, decrypt } from './crypto';

const credential = new StorageSharedKeyCredential(
  config.storageAccountName,
  config.storageAccountKey
);

const blobServiceClient = new BlobServiceClient(
  `https://${config.storageAccountName}.blob.core.windows.net`,
  credential
);

const containerClient = blobServiceClient.getContainerClient(config.storageContainerName);

export async function uploadFileToBlob(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<string> {
  const encrypted = encrypt(buffer);
  const blockBlobClient = containerClient.getBlockBlobClient(filename);
  await blockBlobClient.upload(encrypted, encrypted.length, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return blockBlobClient.url;
}

export async function uploadFileToBlobRaw(
  buffer: Buffer,
  filename: string,
  contentType: string
): Promise<void> {
  const blockBlobClient = containerClient.getBlockBlobClient(filename);
  await blockBlobClient.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

interface CachedBlob {
  data: Buffer;
  contentType: string;
}

const blobCache = new Map<string, CachedBlob>();

async function downloadBlobBytes(filename: string): Promise<{ raw: Buffer; contentType: string }> {
  const blockBlobClient = containerClient.getBlockBlobClient(filename);
  const downloadResponse = await blockBlobClient.download();
  const contentType = downloadResponse.contentType ?? 'application/octet-stream';
  const chunks: Buffer[] = [];
  for await (const chunk of downloadResponse.readableStreamBody as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return { raw: Buffer.concat(chunks), contentType };
}

export async function downloadBlob(filename: string): Promise<CachedBlob> {
  const cached = blobCache.get(filename);
  if (cached) return cached;

  const { raw, contentType } = await downloadBlobBytes(filename);
  const data = decrypt(raw);

  const entry: CachedBlob = { data, contentType };
  blobCache.set(filename, entry);
  return entry;
}

export async function downloadBlobRaw(filename: string): Promise<{ raw: Buffer; contentType: string }> {
  return downloadBlobBytes(filename);
}

export function evictBlobCache(filename: string): void {
  blobCache.delete(filename);
}

export async function deleteBlob(filename: string): Promise<void> {
  const blockBlobClient = containerClient.getBlockBlobClient(filename);
  await blockBlobClient.deleteIfExists();
  blobCache.delete(filename);
}

export async function getBlobUrl(filename: string): Promise<string> {
  const blockBlobClient = containerClient.getBlockBlobClient(filename);
  return blockBlobClient.url;
}

export async function listBlobs(): Promise<string[]> {
  const names: string[] = [];
  for await (const blob of containerClient.listBlobsFlat()) {
    names.push(blob.name);
  }
  return names;
}
