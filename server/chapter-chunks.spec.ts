import { Chapter } from '../shared/models/chapter.model';

jest.mock('./cosmos', () => {
  const makeContainer = () => {
    const itemApi = { read: jest.fn(), delete: jest.fn(), replace: jest.fn() };
    return {
      items: { query: jest.fn(), upsert: jest.fn() },
      item: jest.fn(() => itemApi),
      __itemApi: itemApi,
    };
  };
  const containers: Record<string, ReturnType<typeof makeContainer>> = {};
  return { getContainer: (name: string) => (containers[name] ??= makeContainer()) };
});

jest.mock('./embeddings', () => ({
  generateEmbedding: jest.fn(),
  generateEmbeddings: jest.fn(),
}));

import { getContainer } from './cosmos';
import { generateEmbedding, generateEmbeddings } from './embeddings';
import { deleteChapterChunks, reindexChapterChunks, searchChapterChunks } from './chapter-chunks';

/* eslint-disable @typescript-eslint/no-explicit-any */
const chunksContainer = getContainer('chapter-chunks') as any;
const booksContainer = getContainer('books') as any;
const embedMock = generateEmbedding as jest.Mock;
const embedBatchMock = generateEmbeddings as jest.Mock;

const OWNER = 'author@example.com';

function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return {
    id: 'ch-1',
    bookId: 'b-1',
    title: 'One',
    owner: OWNER,
    content: '<p>Arthur finds the gate broken.</p>',
    ...overrides,
  } as Chapter;
}

function stubQueryResults(resources: unknown[]): void {
  chunksContainer.items.query.mockReturnValue({ fetchAll: async () => ({ resources }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  stubQueryResults([]);
  booksContainer.__itemApi.read.mockResolvedValue({ resource: { seriesId: 's-1' } });
  embedBatchMock.mockResolvedValue([[0.1, 0.2]]);
  embedMock.mockResolvedValue([0.3, 0.4]);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('deleteChapterChunks', () => {
  it('deletes every chunk belonging to the chapter', async () => {
    stubQueryResults([{ id: 'ch-1:0' }, { id: 'ch-1:1' }]);
    await deleteChapterChunks('ch-1');
    expect(chunksContainer.item).toHaveBeenCalledWith('ch-1:0', 'ch-1');
    expect(chunksContainer.item).toHaveBeenCalledWith('ch-1:1', 'ch-1');
    expect(chunksContainer.__itemApi.delete).toHaveBeenCalledTimes(2);
  });
});

describe('reindexChapterChunks', () => {
  it('embeds passages in one batch and upserts chunk documents', async () => {
    await reindexChapterChunks(makeChapter());
    expect(embedBatchMock).toHaveBeenCalledWith(['Arthur finds the gate broken.']);
    expect(chunksContainer.items.upsert).toHaveBeenCalledTimes(1);
    expect(chunksContainer.items.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ch-1:0',
        chapterId: 'ch-1',
        bookId: 'b-1',
        seriesId: 's-1',
        owner: OWNER,
        chunkIndex: 0,
        content: 'Arthur finds the gate broken.',
        contentVector: [0.1, 0.2],
      }),
    );
  });

  it('leaves a no-content chapter with no chunks', async () => {
    await reindexChapterChunks(makeChapter({ content: '' }));
    expect(embedBatchMock).not.toHaveBeenCalled();
    expect(chunksContainer.items.upsert).not.toHaveBeenCalled();
  });

  it('still indexes when the parent book cannot be read', async () => {
    booksContainer.__itemApi.read.mockRejectedValue(new Error('missing'));
    await reindexChapterChunks(makeChapter());
    expect(chunksContainer.items.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ seriesId: undefined }),
    );
  });

  it('falls back to per-passage embedding when the batch is rejected', async () => {
    embedBatchMock.mockRejectedValue(new Error('content_filter'));
    await reindexChapterChunks(makeChapter());
    expect(embedMock).toHaveBeenCalledWith('Arthur finds the gate broken.');
    expect(chunksContainer.items.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Arthur finds the gate broken.', contentVector: [0.3, 0.4] }),
    );
  });

  it('isolates and drops only the filtered paragraph within a rejected passage', async () => {
    const good = 'Arthur mends the gate before nightfall.';
    const bad = 'The forbidden verse is recited in full.';
    embedBatchMock.mockRejectedValue(new Error('filtered'));
    embedMock.mockImplementation(async (text: string) => {
      if (text.includes('forbidden')) throw new Error('filtered');
      return [0.5];
    });

    await reindexChapterChunks(makeChapter({ content: `<p>${good}</p><p>${bad}</p>` }));

    // The two paragraphs pack into one passage; only the good one survives.
    expect(chunksContainer.items.upsert).toHaveBeenCalledTimes(1);
    expect(chunksContainer.items.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ content: good, contentVector: [0.5] }),
    );
  });

  it('never throws, even when everything fails', async () => {
    chunksContainer.items.query.mockImplementation(() => {
      throw new Error('cosmos down');
    });
    await expect(reindexChapterChunks(makeChapter())).resolves.toBeUndefined();
    expect(chunksContainer.items.upsert).not.toHaveBeenCalled();
  });
});

describe('searchChapterChunks', () => {
  function capturedQuery(): { query: string; parameters: { name: string; value: unknown }[] } {
    return chunksContainer.items.query.mock.calls[0][0];
  }

  it('returns matching chunks scoped to the owner', async () => {
    const hits = [{ chapterId: 'ch-1', content: 'passage', score: 0.9 }];
    stubQueryResults(hits);

    const results = await searchChapterChunks('broken gate', {}, OWNER);
    expect(results).toEqual(hits);

    const { query, parameters } = capturedQuery();
    expect(query).toContain('SELECT TOP 6');
    expect(query).toMatch(/c\.owner = @_owner\s+ORDER BY/);
    expect(parameters).toContainEqual({ name: '@_owner', value: OWNER });
    expect(parameters).toContainEqual({ name: '@vec', value: [0.3, 0.4] });
  });

  it('clamps topK to the 1..50 range', async () => {
    await searchChapterChunks('q', { topK: 999 }, OWNER);
    expect(capturedQuery().query).toContain('SELECT TOP 50');

    chunksContainer.items.query.mockClear();
    stubQueryResults([]);
    await searchChapterChunks('q', { topK: -3 }, OWNER);
    expect(capturedQuery().query).toContain('SELECT TOP 1');
  });

  it('applies chapter, book, and series filters', async () => {
    await searchChapterChunks('q', { chapterId: 'ch-9', bookId: 'b-9', seriesId: 's-9' }, OWNER);
    const { query, parameters } = capturedQuery();
    expect(query).toContain('c.chapterId = @chapterId AND c.bookId = @bookId AND c.seriesId = @seriesId');
    expect(parameters).toContainEqual({ name: '@chapterId', value: 'ch-9' });
    expect(parameters).toContainEqual({ name: '@bookId', value: 'b-9' });
    expect(parameters).toContainEqual({ name: '@seriesId', value: 's-9' });
  });

  it('returns an empty array when the search fails', async () => {
    embedMock.mockRejectedValue(new Error('embedding down'));
    expect(await searchChapterChunks('q', {}, OWNER)).toEqual([]);
  });
});
