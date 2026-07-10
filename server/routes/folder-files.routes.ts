import { Router, Request, Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import path from 'path';
import { getContainer } from '../services/cosmos';
import { uploadFileToBlob, downloadBlob, deleteBlob } from '../services/storage';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// GET /:folderId — list files in a folder
router.get('/:folderId', async (req: Request, res: Response) => {
  const folderId = req.params['folderId'] as string;
  try {
    const container = getContainer('chat-folder-files');
    const { resources } = await container.items
      .query({
        query: `SELECT c.id, c.folderId, c.name, c.blobName, c.contentType, c.size, c.createdAt, c.updatedAt
                FROM c WHERE c.owner = @owner AND c.folderId = @folderId
                  AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)
                ORDER BY c.name ASC`,
        parameters: [
          { name: '@owner', value: req.user!.email },
          { name: '@folderId', value: folderId },
        ],
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error('Error listing folder files:', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// POST /:folderId — upload a file
router.post('/:folderId', upload.single('file'), async (req: Request, res: Response) => {
  const folderId = req.params['folderId'] as string;
  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const id = randomUUID();
  const blobName = `folder-files/${id}${ext}`;

  try {
    await uploadFileToBlob(req.file.buffer, blobName, req.file.mimetype);

    const now = new Date().toISOString();
    const record = {
      id,
      owner: req.user!.email,
      folderId,
      name: req.file.originalname,
      blobName,
      contentType: req.file.mimetype,
      size: req.file.size,
      createdAt: now,
      updatedAt: now,
      deleted: false,
    };

    const container = getContainer('chat-folder-files');
    await container.items.create(record);
    res.json(record);
  } catch (err) {
    console.error('Error uploading folder file:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// GET /:folderId/:fileId/download — proxy the blob to the client
router.get('/:folderId/:fileId/download', async (req: Request, res: Response) => {
  const fileId = req.params['fileId'] as string;
  try {
    const container = getContainer('chat-folder-files');
    const { resource } = await container.item(fileId, fileId).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const blob = await downloadBlob(resource.blobName);
    res.setHeader('Content-Type', blob.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(resource.name)}"`);
    res.setHeader('Content-Length', blob.data.length);
    res.send(blob.data);
  } catch (err) {
    console.error('Error downloading folder file:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// GET /:folderId/:fileId/preview — serve inline for browser preview
router.get('/:folderId/:fileId/preview', async (req: Request, res: Response) => {
  const fileId = req.params['fileId'] as string;
  try {
    const container = getContainer('chat-folder-files');
    const { resource } = await container.item(fileId, fileId).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const blob = await downloadBlob(resource.blobName);
    res.setHeader('Content-Type', blob.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(resource.name)}"`);
    res.setHeader('Content-Length', blob.data.length);
    res.send(blob.data);
  } catch (err) {
    console.error('Error previewing folder file:', err);
    res.status(500).json({ error: 'Preview failed' });
  }
});

// PUT /:folderId/:fileId — rename or move a file
router.put('/:folderId/:fileId', async (req: Request, res: Response) => {
  const fileId = req.params['fileId'] as string;
  const { name, folderId: newFolderId } = req.body;
  if (!name?.trim() && !newFolderId) {
    res.status(400).json({ error: 'name or folderId is required' });
    return;
  }
  try {
    const container = getContainer('chat-folder-files');
    const { resource } = await container.item(fileId, fileId).read<any>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const updated = {
      ...resource,
      ...(name?.trim() && { name: String(name).trim() }),
      ...(newFolderId && { folderId: newFolderId }),
      updatedAt: new Date().toISOString(),
    };
    await container.items.upsert(updated);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error updating folder file:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /:folderId/:fileId — delete a file (blob + record)
router.delete('/:folderId/:fileId', async (req: Request, res: Response) => {
  const fileId = req.params['fileId'] as string;
  try {
    const container = getContainer('chat-folder-files');
    const { resource } = await container.item(fileId, fileId).read<any>();
    if (!resource || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    await deleteBlob(resource.blobName);
    await container.items.upsert({ ...resource, deleted: true, deletedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting folder file:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

export default router;
