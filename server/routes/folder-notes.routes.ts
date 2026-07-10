import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AzureOpenAI } from 'openai';
import { getContainer } from '../services/cosmos';
import config from '../config';
import { FolderNote } from '../../shared/models/folder-note.model';

const router = Router();

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

/** Strip HTML tags and return the first non-empty paragraph of plain text. */
function extractFirstParagraph(html: string): string {
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = plain.match(/[^.!?\n]+[.!?\n]*/g) ?? [];
  // Take up to the first 3 sentences / ~300 chars
  let result = '';
  for (const s of sentences) {
    if ((result + s).length > 300) break;
    result += s;
  }
  return (result || plain).slice(0, 300).trim();
}

/** Call the LLM to produce a short name for the note. */
async function generateNoteName(firstParagraph: string): Promise<string> {
  try {
    const completion = await client.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        {
          role: 'system',
          content:
            'You name notes concisely. Given the opening text of a note, respond with ONLY a short name (2–5 words, no punctuation, title case). Do not explain.',
        },
        { role: 'user', content: firstParagraph },
      ],
      max_tokens: 20,
    });
    const name = completion.choices[0]?.message?.content?.trim();
    return name && name.length > 0 ? name : 'Untitled Note';
  } catch {
    return 'Untitled Note';
  }
}

// GET /:folderId — list notes in a folder
router.get('/:folderId', async (req: Request, res: Response) => {
  const folderId = req.params['folderId'] as string;
  try {
    const container = getContainer('folder-notes');
    const { resources } = await container.items
      .query<FolderNote>({
        query: `SELECT c.id, c.folderId, c.name, c.seriesId, c.createdAt, c.updatedAt
                FROM c WHERE c.owner = @owner AND c.folderId = @folderId
                  AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)
                ORDER BY c.updatedAt DESC`,
        parameters: [
          { name: '@owner', value: req.user!.email },
          { name: '@folderId', value: folderId },
        ],
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error('Error listing folder notes:', err);
    res.status(500).json({ error: 'Failed to list notes' });
  }
});

// POST /:folderId — create a new note; LLM auto-names from first paragraph
router.post('/:folderId', async (req: Request, res: Response) => {
  const folderId = req.params['folderId'] as string;
  const { content = '', seriesId } = req.body as { content?: string; seriesId?: string };

  const id = randomUUID();
  const now = new Date().toISOString();

  let name = 'Untitled Note';
  const firstParagraph = extractFirstParagraph(content);
  if (firstParagraph.length >= 10) {
    name = await generateNoteName(firstParagraph);
  }

  const record: FolderNote & { owner: string; deleted: boolean } = {
    id,
    owner: req.user!.email,
    folderId,
    name,
    content,
    seriesId,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };

  try {
    const container = getContainer('folder-notes');
    await container.items.create(record);
    res.json(record);
  } catch (err) {
    console.error('Error creating folder note:', err);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// GET /:folderId/:noteId — get single note (includes content)
router.get('/:folderId/:noteId', async (req: Request, res: Response) => {
  const noteId = req.params['noteId'] as string;
  try {
    const container = getContainer('folder-notes');
    const { resource } = await container.item(noteId, noteId).read<FolderNote & { owner: string; deleted?: boolean }>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }
    res.json(resource);
  } catch (err) {
    console.error('Error fetching folder note:', err);
    res.status(500).json({ error: 'Failed to fetch note' });
  }
});

// PUT /:folderId/:noteId — save note content; LLM re-names from first paragraph
router.put('/:folderId/:noteId', async (req: Request, res: Response) => {
  const noteId = req.params['noteId'] as string;
  const { content } = req.body as { content: string };

  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content string required' });
    return;
  }

  try {
    const container = getContainer('folder-notes');
    const { resource } = await container.item(noteId, noteId).read<FolderNote & { owner: string; deleted?: boolean }>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }

    let name = resource.name;
    const firstParagraph = extractFirstParagraph(content);
    if (firstParagraph.length >= 10) {
      name = await generateNoteName(firstParagraph);
    }

    const updated = { ...resource, content, name, updatedAt: new Date().toISOString() };
    await container.items.upsert(updated);
    res.json(updated);
  } catch (err) {
    console.error('Error saving folder note:', err);
    res.status(500).json({ error: 'Failed to save note' });
  }
});

// PATCH /:folderId/:noteId/name — rename note
router.patch('/:folderId/:noteId/name', async (req: Request, res: Response) => {
  const noteId = req.params['noteId'] as string;
  const { name } = req.body as { name: string };

  if (!name?.trim()) {
    res.status(400).json({ error: 'name required' });
    return;
  }

  try {
    const container = getContainer('folder-notes');
    const { resource } = await container.item(noteId, noteId).read<FolderNote & { owner: string; deleted?: boolean }>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }
    const updated = { ...resource, name: name.trim(), updatedAt: new Date().toISOString() };
    await container.items.upsert(updated);
    res.json(updated);
  } catch (err) {
    console.error('Error renaming folder note:', err);
    res.status(500).json({ error: 'Failed to rename note' });
  }
});

// DELETE /:folderId/:noteId — soft delete
router.delete('/:folderId/:noteId', async (req: Request, res: Response) => {
  const noteId = req.params['noteId'] as string;
  try {
    const container = getContainer('folder-notes');
    const { resource } = await container.item(noteId, noteId).read<FolderNote & { owner: string; deleted?: boolean }>();
    if (!resource || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Note not found' });
      return;
    }
    await container.items.upsert({ ...resource, deleted: true, deletedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting folder note:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

export default router;
