import { Router, Request, Response } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';
import { getContainer } from '../cosmos';
import { searchChapterChunks } from '../chapter-chunks';
import { Chapter } from '../../shared/models/chapter.model';
import { Book } from '../../shared/models/book.model';
import { Entity } from '../../shared/models/entity.model';
import { EntityQuote } from '../../shared/models/entity-quote.model';

const router = Router();

const client = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

// POST /general — generic inline AI assist (for notes, etc.) with optional series context
router.post('/general', async (req: Request, res: Response) => {
  const { messages, seriesId, selectedText } = req.body as {
    messages: { role: 'user' | 'assistant'; content: string }[];
    seriesId?: string;
    selectedText?: string;
  };

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  let systemPrompt =
    'You are a helpful writing assistant. Provide only the requested content in plain text. ' +
    'Do not use markdown, HTML, or any formatting. Do not include conversational filler or meta-commentary.';

  if (seriesId) {
    try {
      const entitiesContainer = getContainer('entities');
      const { resources } = await entitiesContainer.items
        .query<Entity>({
          query: 'SELECT c.name, c.type, c.biography FROM c WHERE c.seriesId = @seriesId AND (NOT IS_DEFINED(c.deleted) OR c.deleted = false)',
          parameters: [{ name: '@seriesId', value: seriesId }],
        })
        .fetchAll();
      if (resources.length > 0) {
        const entitySummary = resources
          .map(e => `${e.name} (${e.type})${e.biography ? ': ' + e.biography.slice(0, 80) : ''}`)
          .join('\n');
        systemPrompt += `\n\nWorld context — known entities:\n${entitySummary}`;
      }
    } catch {
      // Proceed without entity context
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = await client.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens: 2048,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('General chat streaming error:', err);
    const isContentFilter = (err as { code?: string })?.code === 'content_filter';
    const errorMessage = isContentFilter
      ? 'Your request was blocked by the content filter. Try rephrasing.'
      : 'AI error occurred';
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  } finally {
    res.end();
  }
});

// GET chat history for a chapter (returns empty if soft-deleted or not owned)
router.get('/:chapterId/history', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  try {
    const container = getContainer('chat-history');
    const { resource } = await container.item(chapterId, chapterId).read<{ id: string; owner?: string; deleted?: boolean; messages: { role: string; text: string; imageUrl?: string }[] }>();
    if (!resource || resource.deleted || resource.owner !== req.user!.email) {
      res.json({ messages: [] });
      return;
    }
    res.json({ messages: resource.messages });
  } catch {
    res.json({ messages: [] });
  }
});

// PUT (upsert) chat history for a chapter
router.put('/:chapterId/history', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  const messages: { role: string; text: string; imageUrl?: string }[] = req.body.messages;
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }
  try {
    const container = getContainer('chat-history');
    await container.items.upsert({ id: chapterId, owner: req.user!.email, messages, deleted: false });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving chat history:', err);
    res.status(500).json({ error: 'Failed to save chat history' });
  }
});

// DELETE chat history for a chapter (soft delete — sets deleted: true)
router.delete('/:chapterId/history', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  try {
    const container = getContainer('chat-history');
    await container.items.upsert({ id: chapterId, owner: req.user!.email, messages: [], deleted: true, deletedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error soft-deleting chat history:', err);
    res.status(500).json({ error: 'Failed to clear chat history' });
  }
});

router.post('/:chapterId', async (req: Request, res: Response) => {
  const chapterId = req.params['chapterId'] as string;
  const messages: { role: 'user' | 'assistant'; content: string }[] = req.body.messages;
  const selectedText: string | undefined = req.body.selectedText;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  // Fetch chapter for context
  let systemPrompt = 'You are a helpful writing assistant helping an author with their story. Provide only the requested content in plain text. Do not use markdown, HTML, or any formatting. Do not include conversational filler, preamble, or meta-commentary such as "Sure, here you go" or "Let me generate that for you."';
  try {
    const container = getContainer('chapters');
    const { resource } = await container.item(chapterId, chapterId).read<Chapter>();
    if (resource) {
      const basePrompt = `You are a helpful writing assistant helping an author with their story chapter titled "${resource.title}". Provide only the requested content in plain text. Do not use markdown, HTML, or any formatting. Do not include conversational filler, preamble, or meta-commentary such as "Sure, here you go" or "Let me generate that for you."`;

      // RAG: retrieve the passages from across this book most relevant to the
      // request, instead of dumping the whole chapter into the prompt. Book-wide
      // scope lets the assistant answer questions whose answer lives in another
      // chapter; relevance ranking still surfaces the current chapter when apt.
      const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
      const retrievalQuery = [selectedText, lastUserMessage?.content].filter(Boolean).join('\n\n').trim();
      let chapterContext = '';
      if (retrievalQuery) {
        const chunks = await searchChapterChunks(retrievalQuery, { bookId: resource.bookId, topK: 6 }, req);
        if (chunks.length > 0) {
          const excerpts = chunks.map(c => c.content).join('\n\n---\n\n');
          chapterContext = `\n\nHere are the most relevant excerpts from the book:\n\n${excerpts}`;
        }
      }

      // Fallback: chapter not yet chunked (lazy migration) or search unavailable —
      // dump the chapter content as before, truncated for context size.
      if (!chapterContext) {
        const rawText = (resource.content ?? '').replace(/<[^>]+>/g, '').trim();
        const plainText = rawText.length > 12000 ? rawText.slice(0, 12000) + '\n[...chapter truncated for context...]' : rawText;
        if (plainText) chapterContext = `\n\nHere is the current chapter content:\n\n${plainText}`;
      }

      systemPrompt = basePrompt + chapterContext;

      // When rewording selected text, find the speaker and use their personality profile
      if (selectedText) {
        const speakerPersonality = await findSpeakerPersonality(resource, selectedText);
        if (speakerPersonality) {
          systemPrompt += `\n\n${speakerPersonality}`;
          // If the user sent no reword instructions, inject a default directive
          const lastMessage = messages[messages.length - 1];
          if (lastMessage && lastMessage.role === 'user' && lastMessage.content.trim() === `Selected text:\n"${selectedText}"`) {
            lastMessage.content += '\n\nReword this text in the character\'s authentic voice. Return only the reworded text, no explanation.';
          }
        }
      } else {
        // When inserting, find a character mentioned in the instruction and use their voice.
        // If no specific character is identified, fall back to the narrator's voice.
        const lastMessage = messages[messages.length - 1];
        const instructionText = lastMessage?.content ?? '';
        const voiceContext = await findInsertVoiceContext(resource, instructionText);
        if (voiceContext) {
          systemPrompt += `\n\n${voiceContext}`;
        } else {
          const narratorContext = await findNarratorContext(resource);
          if (narratorContext) {
            systemPrompt += `\n\n${narratorContext}`;
          }
        }
      }
    }
  } catch {
    // Proceed without chapter context
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = await client.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      max_tokens: 2048,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('Chat streaming error:', err);
    const isContentFilter = (err as { code?: string })?.code === 'content_filter';
    const errorMessage = isContentFilter
      ? 'Your request was blocked by the content filter. Try rephrasing.'
      : 'AI error occurred';
    res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
  } finally {
    res.end();
  }
});

async function findInsertVoiceContext(chapter: Chapter, instructionText: string): Promise<string | null> {
  try {
    const booksContainer = getContainer('books');
    const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
    if (!book?.seriesId) return null;

    const entitiesContainer = getContainer('entities');
    const { resources } = await entitiesContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND c.type = @type',
        parameters: [
          { name: '@seriesId', value: book.seriesId },
          { name: '@type', value: 'PERSON' },
        ],
      })
      .fetchAll();

    const persons = resources as Entity[];
    if (persons.length === 0) return null;

    // When surrounding text is included, the full message content looks like:
    // "...Surrounding text:\n"..."\n\nInstruction: <user prompt>"
    // Extract just the instruction so we don't accidentally match a character
    // who happens to be mentioned in the surrounding chapter text instead of
    // the character the user is actually asking about.
    const instructionMatch = instructionText.match(/\n\nInstruction:\s*([\s\S]*)$/);
    const searchText = (instructionMatch ? instructionMatch[1] : instructionText).toLowerCase();

    // Find the first entity whose name appears in the instruction text.
    // Also split entity.name into individual words so that a prompt saying
    // "mendoza" matches an entity named "Carlos Mendoza".
    for (const entity of persons) {
      const nameWords = entity.name.split(/\s+/).filter(w => w.length > 1);
      const names = [
        ...nameWords,
        entity.firstName,
        entity.lastName,
        entity.nickname,
      ].filter(Boolean) as string[];
      if (!names.some(n => searchText.includes(n.toLowerCase()))) continue;

      let result = `The content being inserted includes dialogue for the character "${entity.name}".`;

      // Include personality profile if available
      if (entity.personality) {
        result += ` Use the following personality profile to write in their authentic voice:\n\n${entity.personality}`;
      }

      // Fetch all quotes for this entity and add the top 5 as voice samples
      const quotesContainer = getContainer('entity-quotes');
      const { resources: allQuotes } = await quotesContainer.items
        .query<EntityQuote>({
          query: 'SELECT * FROM c WHERE c.entityId = @entityId',
          parameters: [{ name: '@entityId', value: entity.id }],
        })
        .fetchAll();

      if (allQuotes.length > 0) {
        const sorted = allQuotes.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
        const samples = sorted.slice(0, 5).map(q => `- "${q.text}"`).join('\n');
        result += `\n\nHere are example quotes that represent this character's voice:\n${samples}`;
      }

      // Only return if we have something useful to say
      if (entity.personality || allQuotes.length > 0) return result;
    }

    return null;
  } catch {
    return null;
  }
}

async function findSpeakerPersonality(chapter: Chapter, selectedText: string): Promise<string | null> {
  try {
    // Get the book to find the seriesId
    const booksContainer = getContainer('books');
    const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
    if (!book?.seriesId) return null;

    // Get all PERSON entities with personalities for this series
    const entitiesContainer = getContainer('entities');
    const { resources } = await entitiesContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND c.type = @type',
        parameters: [
          { name: '@seriesId', value: book.seriesId },
          { name: '@type', value: 'PERSON' },
        ],
      })
      .fetchAll();

    const persons = (resources as Entity[]).filter(e => e.personality);
    if (persons.length === 0) return null;

    // Find the selected text within the chapter and get surrounding context
    const plainText = (chapter.content ?? '').replace(/<[^>]+>/g, '');
    const selIdx = plainText.indexOf(selectedText);
    const contextStart = Math.max(0, (selIdx >= 0 ? selIdx : 0) - 400);
    const contextEnd = Math.min(plainText.length, (selIdx >= 0 ? selIdx : 0) + selectedText.length + 400);
    const context = plainText.slice(contextStart, contextEnd).toLowerCase();

    // Find the first entity whose name appears in the surrounding context
    for (const entity of persons) {
      const names = [entity.name, entity.firstName, entity.lastName, entity.nickname].filter(Boolean) as string[];
      if (names.some(n => context.includes(n.toLowerCase()))) {
        let result =
          `The selected text is spoken by the character "${entity.name}". ` +
          `Use the following personality profile to ensure the reworded dialogue stays true to their voice:\n\n${entity.personality}`;

        // Fetch captured voice-sample quotes for this entity (up to 5, newest first)
        const quotesContainer = getContainer('entity-quotes');
        const { resources: entityQuotes } = await quotesContainer.items
          .query<EntityQuote>({
            query: 'SELECT * FROM c WHERE c.entityId = @entityId',
            parameters: [{ name: '@entityId', value: entity.id }],
          })
          .fetchAll();

        if (entityQuotes.length > 0) {
          const sorted = entityQuotes.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
          const samples = sorted.slice(0, 5).map(q => `- "${q.text}"`).join('\n');
          result += `\n\nHere are example quotes that represent this character's voice well:\n${samples}`;
        }

        return result;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function findNarratorContext(chapter: Chapter): Promise<string | null> {
  try {
    const booksContainer = getContainer('books');
    const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
    if (!book?.seriesId) return null;

    const entitiesContainer = getContainer('entities');
    const { resources } = await entitiesContainer.items
      .query({
        query: 'SELECT * FROM c WHERE c.seriesId = @seriesId AND c.isNarrator = true',
        parameters: [{ name: '@seriesId', value: book.seriesId }],
      })
      .fetchAll();

    const narrator = (resources as Entity[])[0];
    if (!narrator) return null;

    let result = '';

    if (narrator.personality) {
      result += `The story is written in a specific narrative voice. Use the following narrator profile to guide the prose style and tone:\n\n${narrator.personality}`;
    }

    const quotesContainer = getContainer('entity-quotes');
    const { resources: quotes } = await quotesContainer.items
      .query<EntityQuote>({
        query: 'SELECT * FROM c WHERE c.entityId = @entityId',
        parameters: [{ name: '@entityId', value: narrator.id }],
      })
      .fetchAll();

    if (quotes.length > 0) {
      const sorted = quotes.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
      const samples = sorted.slice(0, 5).map(q => `- "${q.text}"`).join('\n');
      result += `\n\nHere are example passages that represent the narrator's voice:\n${samples}`;
    }

    return result || null;
  } catch {
    return null;
  }
}

export default router;
