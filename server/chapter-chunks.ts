import { Request } from 'express';
import { SqlParameter } from '@azure/cosmos';
import { getContainer } from './cosmos';
import { generateEmbedding, generateEmbeddings } from './embeddings';
import { chunkHtmlContent } from './chunking';
import { withOwnerFilter } from './owner-guard';
import { Chapter } from '../shared/models/chapter.model';
import { Book } from '../shared/models/book.model';
import { ChapterChunk } from '../shared/models/chapter-chunk.model';

const chunksContainer = getContainer('chapter-chunks');
const booksContainer = getContainer('books');

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
 * Rebuilds the chunk/embedding index for a chapter: removes any existing chunks,
 * splits the chapter content into passages, embeds them in one batch, and stores
 * the resulting ChapterChunk documents. A no-content chapter is left with no
 * chunks. Embedding failures are logged but do not throw, so a chapter save is
 * never blocked by the AI service being unavailable.
 */
export async function reindexChapterChunks(chapter: Chapter): Promise<void> {
  try {
    await deleteChapterChunks(chapter.id);

    const passages = chunkHtmlContent(chapter.content);
    if (passages.length === 0) return;

    // Denormalize seriesId (chapter -> book -> series) so chunks can be searched
    // series-wide without a join.
    let seriesId: string | undefined;
    try {
      const { resource: book } = await booksContainer.item(chapter.bookId, chapter.bookId).read<Book>();
      seriesId = book?.seriesId;
    } catch {
      // Leave seriesId undefined if the book can't be read.
    }

    const vectors = await generateEmbeddings(passages);
    const now = new Date().toISOString();

    await Promise.all(
      passages.map((content, index) => {
        const doc: ChapterChunk = {
          id: `${chapter.id}:${index}`,
          chapterId: chapter.id,
          bookId: chapter.bookId,
          seriesId,
          owner: chapter.owner ?? '',
          chunkIndex: index,
          content,
          contentVector: vectors[index],
          createdAt: now,
          modifiedAt: now,
        };
        return chunksContainer.items.upsert<ChapterChunk>(doc);
      })
    );
  } catch (err) {
    console.error(`Failed to reindex chunks for chapter ${chapter.id}:`, err);
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
    console.log(`[chunk search] ${resources.length} result(s); filters=[${filters.join(', ') || 'owner only'}]`);
    return resources;
  } catch (err) {
    console.error('Chapter chunk search failed:', err);
    return [];
  }
}
