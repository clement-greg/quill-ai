import { Router, Request, Response } from 'express';
import { getContainer } from '../services/cosmos';
import { reindexChapterChunks, deleteChapterChunks } from '../services/chapter-chunks';
import { refreshChapterSummary } from '../services/chapter-summary';
import { Chapter } from '../../shared/models/chapter.model';
import { ContentFilterWarning } from '../../shared/models/chapter-chunk.model';
import { Book } from '../../shared/models/book.model';
import { Series } from '../../shared/models/series.model';
import { Entity } from '../../shared/models/entity.model';
import { ChapterDialogue } from '../../shared/models/dialogue.model';
import { withOwnerFilter, readOwnedItem, readAccessibleItem } from '../middleware/owner-guard';
import { attributeDialogue, pruneDialogue, readPending } from '../services/dialogue-speakers';
import { modelFor } from '../services/ai-models';

const router = Router();
const container = getContainer('chapters');
const booksContainer = getContainer('books');
const seriesContainer = getContainer('series');

/** Returns true if the user has owner or collaborator access to the series containing the given book. */
async function canAccessBook(bookId: string, req: import('express').Request): Promise<boolean> {
  const { resource: book } = await booksContainer.item(bookId, bookId).read<Book>();
  if (!book) return false;
  const series = await readAccessibleItem<Series>(seriesContainer, book.seriesId, book.seriesId, req);
  return series !== null;
}

// GET all chapters
router.get('/', async (req: Request, res: Response) => {
  try {
    const { resources } = await container.items
      .query(withOwnerFilter(req, 'SELECT * FROM c WHERE (NOT IS_DEFINED(c.archived) OR c.archived = false)'))
      .fetchAll();
    res.json(resources as Chapter[]);
  } catch (err) {
    console.error('Error fetching chapters:', err);
    res.status(500).json({ error: 'Failed to fetch chapters' });
  }
});

// GET all archived chapters
router.get('/archived', async (req: Request, res: Response) => {
  try {
    const { resources } = await container.items
      .query(withOwnerFilter(req, 'SELECT * FROM c WHERE c.archived = true'))
      .fetchAll();
    res.json(resources as Chapter[]);
  } catch (err) {
    console.error('Error fetching archived chapters:', err);
    res.status(500).json({ error: 'Failed to fetch archived chapters' });
  }
});

// GET chapters by book
router.get('/book/:bookId', async (req: Request, res: Response) => {
  try {
    const bookId = req.params['bookId'] as string;
    const hasAccess = await canAccessBook(bookId, req);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const { resources } = await container.items
      .query({
        query: 'SELECT * FROM c WHERE c.bookId = @bookId AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
        parameters: [{ name: '@bookId', value: bookId }],
      })
      .fetchAll();
    res.json(resources as Chapter[]);
  } catch (err) {
    console.error('Error fetching chapters by book:', err);
    res.status(500).json({ error: 'Failed to fetch chapters by book' });
  }
});

// GET single chapter by id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const resource = await container.item(id, id).read<Chapter>().then(r => r.resource);
    if (!resource) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const hasAccess = await canAccessBook(resource.bookId, req);
    if (!hasAccess) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    res.json(resource);
  } catch (err) {
    console.error('Error fetching chapter:', err);
    res.status(500).json({ error: 'Failed to fetch chapter' });
  }
});

// POST create new chapter
router.post('/', async (req: Request, res: Response) => {
  try {
    const chapter: Chapter = req.body;
    if (!chapter.title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }
    if (!chapter.bookId) {
      res.status(400).json({ error: 'Book is required' });
      return;
    }
    const now = new Date().toISOString();
    chapter.owner = chapter.owner || req.user!.email;
    chapter.createdBy = req.user!.email;
    chapter.createdAt = now;
    chapter.modifiedBy = req.user!.email;
    chapter.modifiedAt = now;
    const { resource } = await container.items.create<Chapter>(chapter);
    let contentWarnings: ContentFilterWarning[] = [];
    if (resource) {
      contentWarnings = (await reindexChapterChunks(resource)) ?? [];
      void refreshChapterSummary(resource);
    }
    res.status(201).json(contentWarnings.length ? { ...resource, contentWarnings } : resource);
  } catch (err) {
    console.error('Error creating chapter:', err);
    res.status(500).json({ error: 'Failed to create chapter' });
  }
});

// PATCH reorder chapters
router.patch('/reorder', async (req: Request, res: Response) => {
  try {
    const items: { id: string; sortOrder: number }[] = req.body;
    await Promise.all(
      items.map(async ({ id, sortOrder }) => {
        const { resource } = await container.item(id, id).read<Chapter>();
        if (resource) {
          await container.item(id, id).replace<Chapter>({ ...resource, sortOrder });
        }
      })
    );
    res.status(204).send();
  } catch (err) {
    console.error('Error reordering chapters:', err);
    res.status(500).json({ error: 'Failed to reorder chapters' });
  }
});

// PUT update chapter
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const chapter: Chapter = { ...req.body, id, owner: req.body.owner || req.user!.email, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    // Embeddings now live in the chapter-chunks container; strip any legacy
    // whole-chapter vector so it doesn't linger on the document (lazy migration).
    delete (chapter as { contentVector?: unknown }).contentVector;
    // Dialogue speakers are written by POST /:id/dialogue after a save; the
    // client's copy may predate the last one, so keep what's stored.
    const { resource: stored } = await container.item(id, id).read<Chapter>();
    if (stored?.dialogue) chapter.dialogue = stored.dialogue;
    else delete chapter.dialogue;
    const { resource } = await container.item(id, id).replace<Chapter>(chapter);
    let contentWarnings: ContentFilterWarning[] = [];
    if (resource) {
      contentWarnings = (await reindexChapterChunks(resource)) ?? [];
      // Regenerate the continuity summary in the background — never block the
      // save on the AI service (mirrors reindex's fire-and-forget tolerance).
      void refreshChapterSummary(resource);
    }
    res.json(contentWarnings.length ? { ...resource, contentWarnings } : resource);
  } catch (err) {
    console.error('Error updating chapter:', err);
    res.status(500).json({ error: 'Failed to update chapter' });
  }
});

// POST attribute dialogue — { keys, pending } (see DialogueTagRequest). Drops
// attributions for paragraphs no longer in the chapter (edited or deleted) and
// asks the model about pending paragraphs that have none yet, so each line is
// only ever attributed once. Answers with the chapter's dialogue map.
router.post('/:id/dialogue', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { keys, pending } = (req.body ?? {}) as { keys?: unknown; pending?: unknown };
    const paragraphs = readPending(pending);
    if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string') || !paragraphs) {
      res.status(400).json({ error: 'keys and pending are required' });
      return;
    }
    const { resource: chapter } = await container.item(id, id).read<Chapter>();
    if (!chapter || !(await canAccessBook(chapter.bookId, req))) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const current = new Set(keys as string[]);
    const known = pruneDialogue(chapter.dialogue, current);
    const todo = paragraphs.filter(p => current.has(p.key) && !(p.key in known));

    let added: ChapterDialogue = {};
    if (todo.length) {
      const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
      const { resources: characters } = await getContainer('entities').items
        .query<Entity>({
          query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND c.type = @type AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
          parameters: [{ name: '@seriesId', value: book?.seriesId ?? '' }, { name: '@type', value: 'PERSON' }],
        })
        .fetchAll();
      const live = characters.filter(c => !c.deleted);
      added = live.length
        ? await attributeDialogue(todo, {
          model: await modelFor(req.user, 'dialogueSpeakers'),
          characters: live,
          povEntityId: chapter.povEntityId,
        })
        // No characters to choose from: every line is narration.
        : Object.fromEntries(todo.map(p => [p.key, p.spans.map(() => null)]));
    }

    const unchanged = !Object.keys(added).length
      && Object.keys(known).length === Object.keys(chapter.dialogue ?? {}).length;
    if (unchanged) {
      res.json({ dialogue: known });
      return;
    }
    // Re-read so a save that landed meanwhile isn't overwritten.
    const { resource: fresh } = await container.item(id, id).read<Chapter>();
    if (!fresh) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const dialogue = { ...pruneDialogue(fresh.dialogue, current), ...added };
    await container.item(id, id).replace<Chapter>({ ...fresh, dialogue });
    res.json({ dialogue });
  } catch (err) {
    console.error('Error attributing dialogue:', err);
    res.status(500).json({ error: 'Failed to attribute dialogue' });
  }
});

// PATCH change one line's speaker — { key, index, entityId } (entityId null =
// narration voice). Used when the author corrects the model. The paragraph
// must already be attributed, and the entity must be a character in the
// chapter's series. Answers with the chapter's dialogue map.
router.patch('/:id/dialogue', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { key, index, entityId } = (req.body ?? {}) as { key?: unknown; index?: unknown; entityId?: unknown };
    if (typeof key !== 'string' || !Number.isInteger(index) || (index as number) < 0
      || (entityId !== null && typeof entityId !== 'string')) {
      res.status(400).json({ error: 'key, index and entityId are required' });
      return;
    }
    const { resource: chapter } = await container.item(id, id).read<Chapter>();
    if (!chapter || !(await canAccessBook(chapter.bookId, req))) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const speakers = chapter.dialogue?.[key];
    if (!speakers || (index as number) >= speakers.length) {
      res.status(409).json({ error: 'That line has changed since it was attributed. Save the chapter and try again.' });
      return;
    }
    if (entityId !== null) {
      const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
      const { resource: entity } = await getContainer('entities').item(entityId as string, entityId as string).read<Entity>();
      if (!entity || entity.type !== 'PERSON' || entity.seriesId !== book?.seriesId) {
        res.status(400).json({ error: 'Not a character in this series' });
        return;
      }
    }
    const next = [...speakers];
    next[index as number] = entityId as string | null;
    const dialogue: ChapterDialogue = { ...chapter.dialogue, [key]: next };
    await container.item(id, id).replace<Chapter>({ ...chapter, dialogue });
    res.json({ dialogue });
  } catch (err) {
    console.error('Error setting dialogue speaker:', err);
    res.status(500).json({ error: 'Failed to set the speaker' });
  }
});

// PATCH archive chapter
router.patch('/:id/archive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { resource: existing } = await container.item(id, id).read<Chapter>();
    if (!existing) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const hasAccess = await canAccessBook(existing.bookId, req);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const updated: Chapter = { ...existing, archived: true, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Chapter>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error archiving chapter:', err);
    res.status(500).json({ error: 'Failed to archive chapter' });
  }
});

// PATCH unarchive chapter
router.patch('/:id/unarchive', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const { resource: existing } = await container.item(id, id).read<Chapter>();
    if (!existing) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }
    const hasAccess = await canAccessBook(existing.bookId, req);
    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const updated: Chapter = { ...existing, archived: false, modifiedBy: req.user!.email, modifiedAt: new Date().toISOString() };
    const { resource } = await container.item(id, id).replace<Chapter>(updated);
    res.json(resource);
  } catch (err) {
    console.error('Error unarchiving chapter:', err);
    res.status(500).json({ error: 'Failed to unarchive chapter' });
  }
});

// DELETE chapter
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    await container.item(id, id).delete();
    await deleteChapterChunks(id);
    res.status(204).send();
  } catch (err) {
    console.error('Error deleting chapter:', err);
    res.status(500).json({ error: 'Failed to delete chapter' });
  }
});

export default router;
