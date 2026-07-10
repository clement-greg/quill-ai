import { Router, Request, Response } from 'express';
import { listBlobs, downloadBlobRaw, uploadFileToBlobRaw, evictBlobCache } from '../services/storage';
import { encrypt } from '../services/crypto';

const router = Router();

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function isImageBlob(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// POST /api/migrate/encrypt-photos
// One-time endpoint to encrypt all existing unencrypted photo blobs in storage.
// Run once after deploying the encryption feature. Idempotent only if all blobs
// are already encrypted — running twice on unencrypted data will double-encrypt.
router.post('/encrypt-photos', async (_req: Request, res: Response) => {
  return;
  const names = await listBlobs();
  const imageNames = names.filter(isImageBlob);

  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const name of imageNames) {
    try {
      const { raw, contentType } = await downloadBlobRaw(name);
      const encryptedBuffer = encrypt(raw);
      await uploadFileToBlobRaw(encryptedBuffer, name, contentType);
      evictBlobCache(name);
      succeeded++;
    } catch (err: any) {
      failed++; 
      errors.push(`${name}: ${err?.message ?? String(err)}`);
      console.error(`migrate: failed to encrypt ${name}`, err);
    }
  }

  res.json({ total: imageNames.length, succeeded, failed, errors });
});

export default router;
