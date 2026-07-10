import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { AzureOpenAI } from 'openai';
import { getContainer } from '../services/cosmos';
import config from '../config';
import { EntityQuote } from '../../shared/models/entity-quote.model';
import { Chapter } from '../../shared/models/chapter.model';
import { Book } from '../../shared/models/book.model';
import { Entity } from '../../shared/models/entity.model';

const router = Router();

const aiClient = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

// POST /api/entity-quotes/capture
// Uses AI to identify the speaker of a quote from surrounding context and creates the record.
router.post('/capture', async (req: Request, res: Response) => {
  const { chapterId, quoteText, surroundingContext } = req.body as {
    chapterId: string;
    quoteText: string;
    surroundingContext?: string;
  };

  if (!chapterId || !quoteText?.trim()) {
    res.status(400).json({ error: 'chapterId and quoteText required' });
    return;
  }

  try {
    // Verify chapter ownership and get bookId
    const chaptersContainer = getContainer('chapters');
    const { resource: chapter } = await chaptersContainer.item(chapterId, chapterId).read<Chapter>();
    if (!chapter || chapter.owner !== req.user!.email) {
      res.status(404).json({ error: 'Chapter not found' });
      return;
    }

    // Get the book to find seriesId
    const booksContainer = getContainer('books');
    const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
    if (!book?.seriesId) {
      res.status(400).json({ error: 'Could not determine series' });
      return;
    }

    // Get all non-archived PERSON entities for this series
    const entitiesContainer = getContainer('entities');
    const { resources } = await entitiesContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND c.type = @type AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
        parameters: [
          { name: '@seriesId', value: book.seriesId },
          { name: '@type', value: 'PERSON' },
        ],
      })
      .fetchAll();

    const persons = resources as Entity[];
    if (persons.length === 0) {
      res.status(400).json({ error: 'No characters found in this series' });
      return;
    }

    // Ask AI to identify the speaker
    const characterList = persons.map(p => p.name).join(', ');
    const contextBlock = surroundingContext
      ? `\n\nSurrounding context:\n${surroundingContext}`
      : '';
    const aiPrompt =
      `The following quote appears in a story:${contextBlock}\n\nQuote: "${quoteText.trim()}"\n\nKnown characters: ${characterList}\n\n` +
      `Who is speaking this quote? Reply with ONLY the exact character name from the list above, or "unknown" if you cannot determine it.`;

    const aiResponse = await aiClient.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [{ role: 'user', content: aiPrompt }],
    });

    const speakerName = (aiResponse.choices[0]?.message?.content ?? '').trim();
    if (!speakerName || speakerName.toLowerCase() === 'unknown') {
      res.status(422).json({ error: 'Could not identify the speaker from the surrounding context' });
      return;
    }

    const entity = persons.find(p => {
      const lower = speakerName.toLowerCase();
      return (
        p.name.toLowerCase() === lower ||
        (p.firstName && lower.includes(p.firstName.toLowerCase())) ||
        (p.lastName && lower.includes(p.lastName.toLowerCase())) ||
        (p.nickname && lower.includes(p.nickname.toLowerCase()))
      );
    });

    if (!entity) {
      res.status(422).json({ error: `Could not match speaker to a known character (AI said: "${speakerName}")` });
      return;
    }

    // Create the quote record
    const quotesContainer = getContainer('entity-quotes');
    const record: EntityQuote = {
      id: randomUUID(),
      chapterId,
      entityId: entity.id,
      text: quoteText.trim(),
      isHighlighted: true,
      owner: req.user!.email,
      createdAt: new Date().toISOString(),
    };
    await quotesContainer.items.create(record);

    res.status(201).json({ quote: record, entityName: entity.name });
  } catch (err) {
    console.error('Error capturing quote:', err);
    res.status(500).json({ error: 'Failed to capture quote' });
  }
});

// POST /api/entity-quotes/sync
// Receives all quotes currently detected in a chapter and syncs them:
//  - upserts quotes that are new
//  - deletes quotes that have been removed from the chapter
//  - preserves isHighlighted on quotes that already exist
router.post('/sync', async (req: Request, res: Response) => {
  const { chapterId, quotes } = req.body as {
    chapterId: string;
    quotes: { entityId: string; text: string }[];
  };

  if (!chapterId || !Array.isArray(quotes)) {
    res.status(400).json({ error: 'chapterId and quotes array required' });
    return;
  }

  const container = getContainer('entity-quotes');

  try {
    // Fetch all existing quotes for this chapter (cross-partition query)
    const { resources: existing } = await container.items
      .query<EntityQuote>({
        query: 'SELECT * FROM c WHERE c.chapterId = @chapterId AND c.owner = @owner',
        parameters: [
          { name: '@chapterId', value: chapterId },
          { name: '@owner', value: req.user!.email },
        ],
      })
      .fetchAll();

    // Build a lookup key: entityId + normalized text
    const normalize = (t: string) => t.trim().toLowerCase();
    const existingMap = new Map(existing.map(q => [`${q.entityId}|${normalize(q.text)}`, q]));
    const incomingKeys = new Set(quotes.map(q => `${q.entityId}|${normalize(q.text)}`));

    // Delete quotes that are no longer in the chapter
    const toDelete = existing.filter(q => !incomingKeys.has(`${q.entityId}|${normalize(q.text)}`));
    await Promise.all(toDelete.map(q => container.item(q.id, q.entityId).delete()));

    // Upsert new quotes (skipping ones that already exist)
    const now = new Date().toISOString();
    const toInsert = quotes.filter(q => !existingMap.has(`${q.entityId}|${normalize(q.text)}`));
    const inserted: EntityQuote[] = await Promise.all(
      toInsert.map(async q => {
        const record: EntityQuote = {
          id: randomUUID(),
          chapterId,
          entityId: q.entityId,
          text: q.text,
          isHighlighted: false,
          owner: req.user!.email,
          createdAt: now,
        };
        await container.items.create(record);
        return record;
      }),
    );

    // Return the surviving + newly inserted set
    const survivors = existing.filter(q => incomingKeys.has(`${q.entityId}|${normalize(q.text)}`));
    res.json([...survivors, ...inserted]);
  } catch (err) {
    console.error('Error syncing entity quotes:', err);
    res.status(500).json({ error: 'Failed to sync entity quotes' });
  }
});

// GET /api/entity-quotes/entity/:entityId
// Returns all captured quotes for a given entity
router.get('/entity/:entityId', async (req: Request, res: Response) => {
  const entityId = req.params['entityId'] as string;
  const container = getContainer('entity-quotes');
  try {
    const { resources } = await container.items
      .query<EntityQuote>({
        query: 'SELECT * FROM c WHERE c.entityId = @entityId AND c.owner = @owner ORDER BY c.createdAt ASC',
        parameters: [
          { name: '@entityId', value: entityId },
          { name: '@owner', value: req.user!.email },
        ],
      })
      .fetchAll();
    res.json(resources);
  } catch (err) {
    console.error('Error fetching entity quotes:', err);
    res.status(500).json({ error: 'Failed to fetch entity quotes' });
  }
});

// POST /api/entity-quotes
// Manually creates a new quote for an entity
router.post('/', async (req: Request, res: Response) => {
  const { entityId, text } = req.body as { entityId: string; text: string };

  if (!entityId || !text?.trim()) {
    res.status(400).json({ error: 'entityId and text required' });
    return;
  }

  const container = getContainer('entity-quotes');
  const now = new Date().toISOString();
  const record: EntityQuote = {
    id: randomUUID(),
    chapterId: '',
    entityId,
    text: text.trim(),
    isHighlighted: false,
    owner: req.user!.email,
    createdAt: now,
  };

  try {
    await container.items.create(record);
    res.status(201).json(record);
  } catch (err) {
    console.error('Error creating entity quote:', err);
    res.status(500).json({ error: 'Failed to create quote' });
  }
});

// PATCH /api/entity-quotes/:id/text
// Updates the text of a manually-created quote
router.patch('/:id/text', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const { entityId, text } = req.body as { entityId: string; text: string };

  if (!entityId || !text?.trim()) {
    res.status(400).json({ error: 'entityId and text required' });
    return;
  }

  const container = getContainer('entity-quotes');
  try {
    const { resource } = await container.item(id, entityId).read<EntityQuote>();
    if (!resource || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    const updated = { ...resource, text: text.trim() };
    await container.items.upsert(updated);
    res.json(updated);
  } catch (err) {
    console.error('Error updating entity quote text:', err);
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

// DELETE /api/entity-quotes/:id
// Permanently deletes a quote
router.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const { entityId } = req.body as { entityId: string };

  if (!entityId) {
    res.status(400).json({ error: 'entityId required' });
    return;
  }

  const container = getContainer('entity-quotes');
  try {
    const { resource } = await container.item(id, entityId).read<EntityQuote>();
    if (!resource || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    await container.item(id, entityId).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deleting entity quote:', err);
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

// PATCH /api/entity-quotes/:id/highlight
// Toggles (or sets) the isHighlighted flag
router.patch('/:id/highlight', async (req: Request, res: Response) => {
  const id = req.params['id'] as string;
  const { entityId, isHighlighted } = req.body as { entityId: string; isHighlighted: boolean };

  if (!entityId || typeof isHighlighted !== 'boolean') {
    res.status(400).json({ error: 'entityId and isHighlighted required' });
    return;
  }

  const container = getContainer('entity-quotes');
  try {
    const { resource } = await container.item(id, entityId).read<EntityQuote>();
    if (!resource || resource.owner !== req.user!.email) {
      res.status(404).json({ error: 'Quote not found' });
      return;
    }
    const updated = { ...resource, isHighlighted };
    await container.items.upsert(updated);
    res.json(updated);
  } catch (err) {
    console.error('Error updating entity quote highlight:', err);
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

export default router;
