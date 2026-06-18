import { Request } from 'express';
import { getContainer } from './cosmos';
import { searchChapterChunks } from './chapter-chunks';
import { Chapter } from '../shared/models/chapter.model';
import { Book } from '../shared/models/book.model';
import { Entity } from '../shared/models/entity.model';
import { EntityQuote } from '../shared/models/entity-quote.model';

/**
 * Builds the chapter-scoped portion of a writing-assistant system prompt:
 * book-wide RAG excerpts (or a truncated chapter dump as fallback) plus the
 * relevant character voice / narrator personality context. Shared by the
 * in-editor inline AI (`/api/chat/:chapterId`) and the chapter-aware quick chat.
 *
 * Returns the chapter title (so callers can phrase their own base prompt) and a
 * `contextSuffix` to append. On any failure it returns empty strings so callers
 * can proceed without chapter context.
 */
export async function buildChapterContextPrompt(
  chapterId: string,
  opts: { selectedText?: string; retrievalQuery?: string; instructionText?: string },
  req: Request,
): Promise<{ chapterTitle: string; contextSuffix: string }> {
  try {
    const container = getContainer('chapters');
    const { resource } = await container.item(chapterId, chapterId).read<Chapter>();
    if (!resource) return { chapterTitle: '', contextSuffix: '' };

    let contextSuffix = '';

    // RAG: retrieve the passages from across this book most relevant to the
    // request, instead of dumping the whole chapter into the prompt. Book-wide
    // scope lets the assistant answer questions whose answer lives in another
    // chapter; relevance ranking still surfaces the current chapter when apt.
    const retrievalQuery = (opts.retrievalQuery ?? '').trim();
    if (retrievalQuery) {
      const chunks = await searchChapterChunks(retrievalQuery, { bookId: resource.bookId, topK: 6 }, req);
      if (chunks.length > 0) {
        const excerpts = chunks.map(c => c.content).join('\n\n---\n\n');
        contextSuffix = `\n\nHere are the most relevant excerpts from the book:\n\n${excerpts}`;
      }
    }

    // Fallback: chapter not yet chunked (lazy migration) or search unavailable —
    // dump the chapter content as before, truncated for context size.
    if (!contextSuffix) {
      const rawText = (resource.content ?? '').replace(/<[^>]+>/g, '').trim();
      const plainText = rawText.length > 12000 ? rawText.slice(0, 12000) + '\n[...chapter truncated for context...]' : rawText;
      if (plainText) contextSuffix = `\n\nHere is the current chapter content:\n\n${plainText}`;
    }

    // Voice/personality: when rewording selected text, use the speaker's voice;
    // when inserting, use a character named in the instruction, else the narrator.
    if (opts.selectedText) {
      const speakerPersonality = await findSpeakerPersonality(resource, opts.selectedText);
      if (speakerPersonality) contextSuffix += `\n\n${speakerPersonality}`;
    } else {
      const voiceContext = await findInsertVoiceContext(resource, opts.instructionText ?? '');
      if (voiceContext) {
        contextSuffix += `\n\n${voiceContext}`;
      } else {
        const narratorContext = await findNarratorContext(resource);
        if (narratorContext) contextSuffix += `\n\n${narratorContext}`;
      }
    }

    return { chapterTitle: resource.title ?? '', contextSuffix };
  } catch {
    return { chapterTitle: '', contextSuffix: '' };
  }
}

export async function findInsertVoiceContext(chapter: Chapter, instructionText: string): Promise<string | null> {
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

export async function findSpeakerPersonality(chapter: Chapter, selectedText: string): Promise<string | null> {
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

export async function findNarratorContext(chapter: Chapter): Promise<string | null> {
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
