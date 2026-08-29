jest.mock('./cosmos', () => {
  const makeContainer = () => {
    return {
      items: { query: jest.fn(() => ({ fetchAll: async () => ({ resources: [] }) })) },
      item: jest.fn(() => ({ read: async () => ({ resource: undefined }) })),
    };
  };
  const containers: Record<string, ReturnType<typeof makeContainer>> = {};
  return { getContainer: (name: string) => (containers[name] ??= makeContainer()) };
});

jest.mock('./chapter-chunks', () => ({
  searchChapterChunks: jest.fn(),
  hybridSearchChapterChunks: jest.fn(),
}));

import { getContainer } from './cosmos';
import { hybridSearchChapterChunks } from './chapter-chunks';
import { buildChapterContextPrompt } from './chapter-ai-context';

/* eslint-disable @typescript-eslint/no-explicit-any */
const chaptersContainer = getContainer('chapters') as any;
const searchMock = hybridSearchChapterChunks as jest.Mock;
const req = { user: { email: 'author@example.com' } } as any;

const CHAPTERS: Record<string, { id: string; bookId: string; title: string; content: string }> = {
  'ch-1': { id: 'ch-1', bookId: 'b-1', title: 'Somewhere over the Rabbit Hole', content: '<p>current</p>' },
  'ch-2': { id: 'ch-2', bookId: 'b-1', title: 'The Mess Hall', content: '<p>earlier</p>' },
};

beforeEach(() => {
  jest.clearAllMocks();
  chaptersContainer.item.mockImplementation((id: string) => ({
    read: async () => ({ resource: CHAPTERS[id] }),
  }));
  searchMock.mockResolvedValue([]);
});

describe('buildChapterContextPrompt retrieval', () => {
  it('retrieves for each query separately rather than concatenating them', async () => {
    await buildChapterContextPrompt(
      'ch-1',
      { retrievalQueries: ['How long is Dale staying?', 'the prose around the cursor'] },
      req,
    );

    // One search per query: a short question must not be diluted by the
    // paragraph of narration next to the author's cursor.
    expect(searchMock).toHaveBeenCalledTimes(2);
    expect(searchMock.mock.calls.map(c => c[0])).toEqual([
      'How long is Dale staying?',
      'the prose around the cursor',
    ]);
    expect(searchMock.mock.calls[0][1]).toMatchObject({ bookId: 'b-1' });
  });

  it('interleaves hits round-robin so no single query crowds the others out', async () => {
    searchMock
      .mockResolvedValueOnce([
        { chapterId: 'ch-2', content: 'two weeks or so', score: 0.1 },
        { chapterId: 'ch-2', content: 'question second', score: 0.3 },
      ])
      .mockResolvedValueOnce([{ chapterId: 'ch-1', content: 'cursor first', score: 0.2 }]);

    const { contextSuffix } = await buildChapterContextPrompt(
      'ch-1',
      { retrievalQueries: ['question', 'cursor context'] },
      req,
    );

    expect(contextSuffix.indexOf('two weeks or so'))
      .toBeLessThan(contextSuffix.indexOf('cursor first'));
    expect(contextSuffix.indexOf('cursor first'))
      .toBeLessThan(contextSuffix.indexOf('question second'));
  });

  it('de-duplicates a passage both queries returned', async () => {
    const shared = { chapterId: 'ch-2', content: 'shared passage', score: 0.1 };
    searchMock.mockResolvedValueOnce([shared]).mockResolvedValueOnce([shared]);

    const { contextSuffix } = await buildChapterContextPrompt('ch-1', { retrievalQueries: ['a', 'b'] }, req);
    expect(contextSuffix.match(/shared passage/g)).toHaveLength(1);
  });

  it('falls back to the chapter text when nothing is indexed', async () => {
    const { contextSuffix, citations } = await buildChapterContextPrompt('ch-1', { retrievalQuery: 'q' }, req);
    expect(contextSuffix).toContain('Here is the current chapter content');
    expect(citations).toEqual([]);
  });
});

describe('buildChapterContextPrompt citations', () => {
  beforeEach(() => {
    searchMock.mockResolvedValue([
      { chapterId: 'ch-2', content: 'two weeks or so', score: 0.1 },
      { chapterId: 'ch-1', content: 'the mess hall', score: 0.2 },
    ]);
  });

  it('numbers the excerpts and returns the source chapters when cite is set', async () => {
    const { contextSuffix, citations } = await buildChapterContextPrompt(
      'ch-1',
      { retrievalQuery: 'how long', cite: true },
      req,
    );

    expect(citations).toEqual([
      { n: 1, chapterId: 'ch-2', title: 'The Mess Hall' },
      { n: 2, chapterId: 'ch-1', title: 'Somewhere over the Rabbit Hole' },
    ]);
    expect(contextSuffix).toContain('[1] (from "The Mess Hall")\ntwo weeks or so');
    expect(contextSuffix).toContain('[2] (from "Somewhere over the Rabbit Hole")\nthe mess hall');
  });

  it('omits the numbering by default, so inline prose insertion cannot emit "[1]"', async () => {
    const { contextSuffix, citations } = await buildChapterContextPrompt(
      'ch-1',
      { retrievalQuery: 'how long' },
      req,
    );

    expect(citations).toEqual([]);
    expect(contextSuffix).toContain('two weeks or so');
    expect(contextSuffix).not.toMatch(/\[\d+\]/);
  });
});
