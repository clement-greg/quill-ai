import { Request } from 'express';
import { SqlParameter } from '@azure/cosmos';
import { getContainer } from './cosmos';
import { generateEmbedding, generateEmbeddings } from './embeddings';
import { chunkHtmlContent } from './chunking';
import { withOwnerFilter } from '../middleware/owner-guard';
import { Chapter } from '../../shared/models/chapter.model';
import { Book } from '../../shared/models/book.model';
import { ChapterChunk, ContentFilterWarning } from '../../shared/models/chapter-chunk.model';

const chunksContainer = getContainer('chapter-chunks');
const booksContainer = getContainer('books');

const PREVIEW_MAX = 200;
const preview = (text: string): string =>
  text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}...` : text;

/** Deletes all chunk documents belonging to a chapter (single partition). */
export async function deleteChapterChunks(chapterId: string): Promise<void> {
  const { resources } = await chunksContainer.items
    .query<{ id: string }>({
      query: 'SELECT c.id FROM c WHERE c.chapterId = @chapterId',
      parameters: [{ name: '@chapterId', value: chapterId }],
    })
    .fetchAll();
  await Promise.all(resources.map(r => chunksContainer.item(r.id, chapterId).delete()));
}

/**
 * Retries a filtered passage paragraph-by-paragraph, keeping whichever
 * paragraphs embed successfully and dropping the one(s) the content filter
 * objects to. Returns the surviving text re-embedded as a whole, or null if
 * every paragraph was filtered (or there was only one to begin with, so
 * there's nothing left to isolate).
 */
async function embedOmittingFilteredParagraphs(
  passage: string,
  chapterId: string,
): Promise<{ content: string; vector: number[]; omitted: string[] } | null> {
  const paragraphs = passage.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1) {
    console.error(`Skipping unembeddable passage in chapter ${chapterId} (no paragraph boundary to isolate it by)`);
    return null;
  }

  const survivors: string[] = [];
  const omitted: string[] = [];
  for (const paragraph of paragraphs) {
    try {
      await generateEmbedding(paragraph);
      survivors.push(paragraph);
    } catch (err) {
      console.error(`Omitting a paragraph that trips the content filter from chapter ${chapterId}:`, err);
      omitted.push(paragraph);
    }
  }
  if (survivors.length === 0) return null;

  const content = survivors.join('\n\n');
  try {
    const vector = await generateEmbedding(content);
    return { content, vector, omitted };
  } catch (err) {
    console.error(`Combined surviving text still filtered for chapter ${chapterId}:`, err);
    return null;
  }
}

/**
 * Rebuilds the chunk/embedding index for a chapter: removes any existing chunks,
 * splits the chapter content into passages, embeds them in one batch, and stores
 * the resulting ChapterChunk documents. A no-content chapter is left with no
 * chunks. Embedding failures are logged but do not throw, so a chapter save is
 * never blocked by the AI service being unavailable. Returns any paragraphs
 * that were dropped by the content filter, so callers can surface them to the
 * author.
 */
export async function reindexChapterChunks(chapter: Chapter): Promise<ContentFilterWarning[]> {
  try {
    await deleteChapterChunks(chapter.id);

    const passages = chunkHtmlContent(chapter.content);
    if (passages.length === 0) return [];

    // Denormalize seriesId (chapter -> book -> series) so chunks can be searched
    // series-wide without a join.
    let seriesId: string | undefined;
    try {
      const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
      seriesId = book?.seriesId;
    } catch {
      // Leave seriesId undefined if the book can't be read.
    }

    // Embed as a batch first; if the batch as a whole gets rejected (e.g. by
    // Azure's content filter reacting to one passage), fall back to embedding
    // passages individually. A passage that's still rejected on its own gets
    // split into its constituent paragraphs (chunkHtmlContent joins them with
    // "\n\n") so only the specific offending paragraph(s) are dropped -- the
    // rest of that passage still gets indexed.
    let results: ({ content: string; vector: number[]; omitted?: string[] } | null)[];
    try {
      const vectors = await generateEmbeddings(passages);
      results = passages.map((content, index) => ({ content, vector: vectors[index] }));
    } catch (err) {
      console.error(`Batch embedding failed for chapter ${chapter.id}, retrying passage-by-passage:`, err);
      results = await Promise.all(
        passages.map(async passage => {
          try {
            const vector = await generateEmbedding(passage);
            return { content: passage, vector };
          } catch (passageErr) {
            console.error(`Passage embedding filtered for chapter ${chapter.id}, isolating offending paragraph(s):`, passageErr);
            return embedOmittingFilteredParagraphs(passage, chapter.id);
          }
        })
      );
    }

    const now = new Date().toISOString();

    await Promise.all(
      results.map((result, index) => {
        if (!result) return undefined;
        const doc: ChapterChunk = {
          id: `${chapter.id}:${index}`,
          chapterId: chapter.id,
          bookId: chapter.bookId,
          seriesId,
          owner: chapter.owner ?? '',
          chunkIndex: index,
          content: result.content,
          contentVector: result.vector,
          createdAt: now,
          modifiedAt: now,
        };
        return chunksContainer.items.upsert<ChapterChunk>(doc);
      })
    );

    const warnings: ContentFilterWarning[] = [];
    results.forEach((result, index) => {
      result?.omitted?.forEach(paragraph => warnings.push({ passageIndex: index, preview: preview(paragraph) }));
    });
    return warnings;
  } catch (err) {
    console.error(`Failed to reindex chunks for chapter ${chapter.id}:`, err);
    return [];
  }
}

export interface ChunkSearchResult {
  chapterId: string;
  content: string;
  score: number;
}

/**
 * Semantic search over chapter chunks using cosine VectorDistance. Scopes results
 * to the requesting user (owner filter) and optionally to a single chapter or
 * book. Returns the top-K most relevant passages ordered by similarity. Returns
 * an empty array on any failure so callers can fall back gracefully.
 */
export async function searchChapterChunks(
  queryText: string,
  opts: { chapterId?: string; bookId?: string; seriesId?: string; topK?: number },
  source: Request | string,
): Promise<ChunkSearchResult[]> {
  try {
    // Coerce to a safe inlined integer — Cosmos does not reliably support a
    // parameterized TOP, and this value is server-controlled (not user input).
    const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 6)));
    const vector = await generateEmbedding(queryText);

    const filters: string[] = [];
    const parameters: SqlParameter[] = [{ name: '@vec', value: vector }];
    if (opts.chapterId) {
      filters.push('c.chapterId = @chapterId');
      parameters.push({ name: '@chapterId', value: opts.chapterId });
    }
    if (opts.bookId) {
      filters.push('c.bookId = @bookId');
      parameters.push({ name: '@bookId', value: opts.bookId });
    }
    if (opts.seriesId) {
      filters.push('c.seriesId = @seriesId');
      parameters.push({ name: '@seriesId', value: opts.seriesId });
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')} ` : '';
    // The third arg `true` forces brute-force (full-scan) distance, which is
    // required when the container has no dedicated vector index — exactly our
    // setup (see cosmos.ts). The SELECT and ORDER BY expressions must match.
    const distance = 'VectorDistance(c.contentVector, @vec, true)';
    const query = withOwnerFilter(source, {
      query:
        `SELECT TOP ${topK} c.chapterId, c.content, ${distance} AS score ` +
        `FROM c ${where}ORDER BY ${distance}`,
      parameters,
    });

    const { resources } = await chunksContainer.items.query<ChunkSearchResult>(query).fetchAll();
    return resources;
  } catch (err) {
    console.error('Chapter chunk search failed:', err);
    return [];
  }
}

/**
 * Literal keyword search over chapter chunks. Vector search is weak at exact
 * lexical lookup — a proper noun, an alias, a number, a phrase the author
 * remembers verbatim — because a short name embeds into roughly the same place
 * as every other name. This complements it with a substring match.
 *
 * The full phrase is tried first; if it yields nothing, the query's significant
 * tokens (stop words and 2-letter fragments dropped) are AND-ed, so "how long
 * did Dale stay" still matches a passage containing both "Dale" and "stay".
 * Returns an empty array on any failure so callers can fall back gracefully.
 */
const KEYWORD_STOP_WORDS = new Set([
  'the', 'and', 'was', 'were', 'that', 'this', 'with', 'for', 'from', 'his', 'her', 'she', 'him',
  'they', 'them', 'their', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how', 'did',
  'does', 'do', 'is', 'are', 'be', 'been', 'has', 'have', 'had', 'will', 'would', 'about', 'into',
  'said', 'says', 'say', 'tell', 'told', 'you', 'your', 'not', 'but', 'any', 'all', 'can', 'could',
  'long', 'much', 'many', 'get', 'got', 'chapter', 'chapters', 'story', 'book',
]);

export async function keywordSearchChapterChunks(
  queryText: string,
  opts: { chapterId?: string; bookId?: string; seriesId?: string; topK?: number },
  source: Request | string,
): Promise<ChunkSearchResult[]> {
  const term = queryText.trim();
  if (!term) return [];
  const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 6)));

  const scopeFilters: string[] = [];
  const scopeParams: SqlParameter[] = [];
  if (opts.chapterId) {
    scopeFilters.push('c.chapterId = @chapterId');
    scopeParams.push({ name: '@chapterId', value: opts.chapterId });
  }
  if (opts.bookId) {
    scopeFilters.push('c.bookId = @bookId');
    scopeParams.push({ name: '@bookId', value: opts.bookId });
  }
  if (opts.seriesId) {
    scopeFilters.push('c.seriesId = @seriesId');
    scopeParams.push({ name: '@seriesId', value: opts.seriesId });
  }

  const run = async (matchFilters: string[], matchParams: SqlParameter[]): Promise<ChunkSearchResult[]> => {
    const filters = [...scopeFilters, ...matchFilters];
    const query = withOwnerFilter(source, {
      // score 0 keeps the shape identical to the vector results (0 = perfect
      // match under cosine distance), so callers can merge the two lists.
      query: `SELECT TOP ${topK} c.chapterId, c.content, 0 AS score FROM c WHERE ${filters.join(' AND ')}`,
      parameters: [...scopeParams, ...matchParams],
    });
    const { resources } = await chunksContainer.items.query<ChunkSearchResult>(query).fetchAll();
    return resources;
  };

  try {
    // `true` = case-insensitive CONTAINS.
    const phraseHits = await run(['CONTAINS(c.content, @term, true)'], [{ name: '@term', value: term }]);
    if (phraseHits.length > 0) return phraseHits;

    const tokens = [...new Set(
      term.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/)
        .filter(t => t.length > 2 && !KEYWORD_STOP_WORDS.has(t))
    )].slice(0, 6);
    if (tokens.length === 0) return [];

    return await run(
      tokens.map((_, i) => `CONTAINS(c.content, @t${i}, true)`),
      tokens.map((t, i) => ({ name: `@t${i}`, value: t })),
    );
  } catch (err) {
    console.error('Chapter chunk keyword search failed:', err);
    return [];
  }
}

/**
 * Hybrid retrieval: semantic (vector) hits plus literal keyword hits, merged and
 * de-duplicated. Keyword hits are appended after the vector hits rather than
 * interleaved, since their score is synthetic and not comparable.
 */
export async function hybridSearchChapterChunks(
  queryText: string,
  opts: { chapterId?: string; bookId?: string; seriesId?: string; topK?: number },
  source: Request | string,
): Promise<ChunkSearchResult[]> {
  const topK = Math.max(1, Math.min(50, Math.floor(opts.topK ?? 6)));
  const [vectorHits, keywordHits] = await Promise.all([
    searchChapterChunks(queryText, opts, source),
    keywordSearchChapterChunks(queryText, opts, source),
  ]);

  const merged: ChunkSearchResult[] = [];
  const seen = new Set<string>();
  for (const hit of [...vectorHits, ...keywordHits]) {
    const key = `${hit.chapterId}::${hit.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return merged.slice(0, topK * 2);
}
