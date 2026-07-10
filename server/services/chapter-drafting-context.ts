import { Request } from 'express';
import { AzureOpenAI } from 'openai';
import config from '../config';
import { getContainer } from './cosmos';
import { searchChapterChunks } from './chapter-chunks';
import { ensureChapterSummary } from './chapter-summary';
import { findNarratorContext } from './chapter-ai-context';
import { Chapter, OutlineItem, ChapterNote } from '../../shared/models/chapter.model';
import { Book } from '../../shared/models/book.model';
import { Series } from '../../shared/models/series.model';
import { Entity } from '../../shared/models/entity.model';
import { EntityQuote } from '../../shared/models/entity-quote.model';

/** Roughly how much verbatim prose from the prior chapter to carry as a
 * seamless continuation anchor. */
const PREV_CHAPTER_TAIL_WORDS = 800;
/** Cap the number of cast members we profile so the prompt stays bounded. */
const MAX_CAST = 6;
/** Voice samples per profiled character. */
const QUOTES_PER_CHARACTER = 4;

interface DraftingContextOptions {
  /** The chapter's working outline (may be unsaved edits from the editor). */
  outline?: OutlineItem[];
  /** The chapter's working notes (may be unsaved edits from the editor). */
  notes?: ChapterNote[];
  /** The author's natural-language instruction (e.g. "write the chapter"). */
  instructionText?: string;
}

/** Strips HTML and collapses whitespace. */
function toPlainText(html: string | undefined): string {
  return (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Returns the last `wordCount` words of plain text from HTML content. */
function tailWords(html: string | undefined, wordCount: number): string {
  const words = toPlainText(html).split(' ').filter(Boolean);
  if (words.length <= wordCount) return words.join(' ');
  return '…' + words.slice(-wordCount).join(' ');
}

/** Renders an outline as an indented bullet list. */
function renderOutline(outline: OutlineItem[] | undefined): string {
  if (!outline?.length) return '';
  return outline.map(i => `${i.level === 1 ? '  - ' : '- '}${i.text}`).join('\n');
}

/** Renders notes, surfacing the anchored selection when present. */
function renderNotes(notes: ChapterNote[] | undefined): string {
  if (!notes?.length) return '';
  return notes
    .map(n => (n.selectedText ? `- [on "${n.selectedText}"]: ${n.noteText}` : `- ${n.noteText}`))
    .join('\n');
}

/** All the name variants an entity can be referred to by, lowercased. */
function entityNameVariants(e: Entity): string[] {
  const words = e.name.split(/\s+/).filter(w => w.length > 1);
  return [...words, e.firstName, e.lastName, e.nickname, e.title, ...(e.aliases ?? [])]
    .filter((v): v is string => Boolean(v) && v!.length > 1)
    .map(v => v.toLowerCase());
}

/** Builds a personality + voice-sample block for one character. */
async function buildVoiceBlock(entity: Entity): Promise<string> {
  let block = '';
  if (entity.personality) {
    block += `Personality / voice profile:\n${entity.personality}`;
  }
  try {
    const quotesContainer = getContainer('entity-quotes');
    const { resources } = await quotesContainer.items
      .query<EntityQuote>({
        query: 'SELECT * FROM c WHERE c.entityId = @entityId',
        parameters: [{ name: '@entityId', value: entity.id }],
      })
      .fetchAll();
    if (resources.length > 0) {
      const samples = resources
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
        .slice(0, QUOTES_PER_CHARACTER)
        .map(q => `- "${q.text}"`)
        .join('\n');
      block += `${block ? '\n\n' : ''}Example lines in their voice:\n${samples}`;
    }
  } catch {
    // Best-effort; omit quotes on failure.
  }
  return block;
}

/** Describes a character compactly for the cast list. */
function castLine(e: Entity): string {
  const refHint = e.preferredReference ? ` (refer to as: ${e.preferredReference})` : '';
  const bio = e.biography ? ` — ${e.biography}` : '';
  return `**${e.name}**${refHint}${bio}`;
}

/**
 * Assembles a rich, continuity-aware system prompt for drafting a full chapter.
 * Layers (highest priority first): authorial intent (outline/notes), series &
 * book direction, narrative continuity (prior chapter tail + "story so far"
 * summaries), point-of-view voice, the relevant cast with bios & voice samples,
 * and finally RAG-retrieved passages to fill any gaps.
 *
 * Degrades gracefully: any layer that can't be built is simply omitted, and on
 * a total failure it returns a minimal prompt so drafting can still proceed.
 */
export async function buildChapterDraftingContext(
  chapterId: string,
  opts: DraftingContextOptions,
  req: Request,
): Promise<{ systemPrompt: string; chapterTitle: string }> {
  const { contextText, chapterTitle } = await buildChapterContext(chapterId, opts, req);
  const systemPrompt = baseDraftingInstructions(chapterTitle) +
    (contextText ? `\n\n${contextText}` : '');
  return { systemPrompt, chapterTitle };
}

/**
 * Builds just the grounding CONTEXT for a chapter (no task-specific preamble):
 * series & book direction, authorial intent, narrative continuity (story-so-far
 * summaries + prior-chapter tail), POV voice, cast bios & voice samples, and
 * RAG-retrieved passages. Shared by chapter drafting and the Quill Editor pass.
 */
export async function buildChapterContext(
  chapterId: string,
  opts: DraftingContextOptions,
  req: Request,
): Promise<{ contextText: string; chapterTitle: string }> {
  const sections: string[] = [];
  let chapterTitle = '';

  try {
    const chaptersContainer = getContainer('chapters');
    const { resource: chapter } = await chaptersContainer.item(chapterId, chapterId).read<Chapter>();
    if (!chapter) {
      return { contextText: '', chapterTitle: '' };
    }
    chapterTitle = chapter.title ?? '';

    // Prefer the live editor outline/notes; fall back to the saved chapter.
    const outline = opts.outline ?? chapter.outline;
    const notes = opts.notes ?? chapter.notes;

    // ── Book & series ──────────────────────────────────────────────────────
    const booksContainer = getContainer('books');
    const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
    let series: Series | undefined;
    if (book?.seriesId) {
      const seriesContainer = getContainer('series');
      series = (await seriesContainer.item(book.seriesId, book.seriesId).read<Series>()).resource ?? undefined;
    }

    if (series?.systemPrompt) {
      sections.push(`SERIES STYLE & DIRECTION:\n${series.systemPrompt}`);
    }

    const bookOutline = renderOutline(book?.outline);
    if (bookOutline) sections.push(`BOOK OUTLINE:\n${bookOutline}`);
    if (book?.notes) sections.push(`BOOK NOTES:\n${book.notes}`);

    // ── Authorial intent for THIS chapter (highest priority) ───────────────
    const chapterOutline = renderOutline(outline);
    if (chapterOutline) {
      sections.push(`OUTLINE FOR THIS CHAPTER (follow it closely):\n${chapterOutline}`);
    }
    const chapterNotes = renderNotes(notes);
    if (chapterNotes) {
      sections.push(`AUTHOR'S NOTES FOR THIS CHAPTER (honor these):\n${chapterNotes}`);
    }
    if (chapter.setting) sections.push(`SETTING: ${chapter.setting}`);
    if (chapter.inStoryTime) sections.push(`STORY-TIME: ${chapter.inStoryTime}`);

    // ── Narrative continuity ───────────────────────────────────────────────
    // Load sibling chapters in reading order to find what comes before.
    const { resources: siblings } = await chaptersContainer.items
      .query<Chapter>({
        query: 'SELECT * FROM c WHERE c.bookId = @bookId AND (NOT IS_DEFINED(c.archived) OR c.archived = false)',
        parameters: [{ name: '@bookId', value: chapter.bookId }],
      })
      .fetchAll();
    const ordered = siblings.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
    const currentIndex = ordered.findIndex(c => c.id === chapter.id);
    const preceding = currentIndex >= 0 ? ordered.slice(0, currentIndex) : [];

    if (preceding.length > 0) {
      // "Story so far": ordered chapter summaries (lazily backfilled).
      const summaries = await Promise.all(
        preceding.map(async c => {
          const summary = await ensureChapterSummary(c);
          return summary ? `- ${c.title || 'Untitled'}: ${summary}` : null;
        }),
      );
      const storySoFar = summaries.filter(Boolean).join('\n');
      if (storySoFar) sections.push(`STORY SO FAR (earlier chapters, in order):\n${storySoFar}`);

      // Verbatim tail of the immediately preceding chapter for seamless voice,
      // tense and POV continuation.
      const prev = preceding[preceding.length - 1];
      const tail = tailWords(prev.content, PREV_CHAPTER_TAIL_WORDS);
      if (tail) {
        sections.push(
          `HOW THE PREVIOUS CHAPTER ("${prev.title || 'Untitled'}") ENDS ` +
            `(continue seamlessly from here — match its voice, tense and POV; do NOT repeat it):\n"${tail}"`,
        );
      }
    }

    // ── Cast, POV & voice ──────────────────────────────────────────────────
    let entities: Entity[] = [];
    if (series?.id) {
      const entitiesContainer = getContainer('entities');
      const { resources } = await entitiesContainer.items
        .query<Entity>({
          query: 'SELECT * FROM c WHERE c.seriesId = @seriesId',
          parameters: [{ name: '@seriesId', value: series.id }],
        })
        .fetchAll();
      entities = resources.filter(e => !e.deleted && !e.archived);
    }

    const persons = entities.filter(e => e.type === 'PERSON');

    // Determine the POV character: explicit povEntityId, else the narrator.
    const povEntity = chapter.povEntityId
      ? persons.find(e => e.id === chapter.povEntityId)
      : undefined;

    if (povEntity) {
      const voice = await buildVoiceBlock(povEntity);
      sections.push(
        `POINT OF VIEW: Write from ${povEntity.name}'s perspective.` +
          (voice ? `\n${voice}` : ''),
      );
    } else {
      // Fall back to the series narrator voice (reuses existing helper).
      const narrator = await findNarratorContext(chapter);
      if (narrator) sections.push(`NARRATIVE VOICE:\n${narrator}`);
    }

    // Relevant cast: characters named in the intent text or the prior tail.
    const intentHaystack = [
      chapterOutline,
      chapterNotes,
      opts.instructionText ?? '',
      preceding.length ? tailWords(preceding[preceding.length - 1].content, PREV_CHAPTER_TAIL_WORDS) : '',
    ]
      .join(' ')
      .toLowerCase();

    const relevant = persons
      .filter(e => e.id !== povEntity?.id)
      .filter(e => entityNameVariants(e).some(n => intentHaystack.includes(n)))
      .slice(0, MAX_CAST);

    if (relevant.length > 0) {
      const castLines = relevant.map(castLine).join('\n');
      sections.push(`CHARACTERS LIKELY IN THIS CHAPTER:\n${castLines}`);
    }

    // Relevant places / things mentioned in the intent text.
    const places = entities
      .filter(e => e.type !== 'PERSON')
      .filter(e => entityNameVariants(e).some(n => intentHaystack.includes(n)))
      .slice(0, MAX_CAST);
    if (places.length > 0) {
      const placeLines = places
        .map(e => `**${e.name}**${e.biography ? ` — ${e.biography}` : ''}`)
        .join('\n');
      sections.push(`PLACES / THINGS OF NOTE:\n${placeLines}`);
    }

    // ── RAG fill ───────────────────────────────────────────────────────────
    const retrievalQuery = [chapterOutline, chapterNotes, opts.instructionText].filter(Boolean).join('\n\n').trim();
    if (retrievalQuery) {
      const chunks = await searchChapterChunks(retrievalQuery, { bookId: chapter.bookId, topK: 6 }, req);
      // Drop chunks from the current chapter (we already have its outline/notes).
      const excerpts = chunks
        .filter(c => c.chapterId !== chapter.id)
        .map(c => c.content)
        .join('\n\n---\n\n');
      if (excerpts) {
        sections.push(`RELEVANT PASSAGES FROM ELSEWHERE IN THE BOOK (for consistency):\n${excerpts}`);
      }
    }
  } catch (err) {
    console.error('Failed to build chapter context:', err);
  }

  return { contextText: sections.length ? sections.join('\n\n') : '', chapterTitle };
}

const beatSheetClient = new AzureOpenAI({
  endpoint: config.foundry.endpoint,
  apiKey: config.foundry.key,
  apiVersion: '2024-10-21',
});

/**
 * Stage 1 of drafting: turn the assembled context into a short, ordered scene
 * beat sheet. Cheap (mini model) and dramatically improves the structural
 * coherence of the prose draft that follows. Returns null on failure so the
 * caller can fall back to drafting directly from the outline.
 */
export async function generateChapterBeatSheet(
  draftingSystemPrompt: string,
  instructionText: string,
): Promise<string | null> {
  try {
    const response = await beatSheetClient.chat.completions.create({
      model: config.foundry.miniModel,
      messages: [
        {
          role: 'system',
          content:
            draftingSystemPrompt +
            '\n\nBEFORE writing prose, produce a brief scene-by-scene BEAT SHEET for this chapter: ' +
            'a numbered list of 4-8 beats, each a single sentence, that realizes the outline and notes ' +
            'and flows naturally from the previous chapter. Output ONLY the numbered list — no prose, ' +
            'no preamble, no commentary.',
        },
        { role: 'user', content: instructionText || 'Plan the chapter.' },
      ],
      stream: false,
    });
    return response.choices[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('Failed to generate chapter beat sheet:', err);
    return null;
  }
}

/** The fixed instruction preamble for chapter drafting. */
function baseDraftingInstructions(chapterTitle: string): string {
  const titlePart = chapterTitle ? ` titled "${chapterTitle}"` : '';
  return (
    `You are an expert novelist drafting a full chapter${titlePart} for the author. ` +
    'Write polished, immersive prose that realizes the outline and honors the notes below, ' +
    'staying consistent with the established story, characters and voice. ' +
    'Produce only the chapter prose — no titles, no headings, no commentary, and no meta text ' +
    'such as "Here is the chapter". Use the surrounding context for continuity but do NOT copy it verbatim.'
  );
}
