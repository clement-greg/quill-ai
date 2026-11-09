jest.mock('./cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('./embeddings', () => ({ generateEmbedding: jest.fn() }));

import { FakeCosmos } from '../testing/fake-cosmos';
import { generateEmbedding } from './embeddings';
import {
  backfillThoughtVectors,
  hasAllTags,
  keywordHits,
  searchThoughts,
  searchWords,
  thoughtEmbeddingText,
} from './thought-search';

const fake = jest.requireMock('./cosmos').__fake as FakeCosmos;
const embed = generateEmbedding as jest.Mock;
const OWNER = 'a@example.com';
const thoughts = () => fake.container('thought-items');

/**
 * The fake container can't evaluate VectorDistance, so semantic queries are
 * answered from this list (already in similarity order), as Cosmos would.
 */
let semanticResults: Record<string, unknown>[] = [];

beforeEach(() => {
  fake.reset();
  embed.mockReset();
  embed.mockResolvedValue([0.5, 0.5]);
  semanticResults = [];
  const container = thoughts();
  const realQuery = container.items.query;
  jest.spyOn(container.items, 'query').mockImplementation((spec: any, opts?: unknown) => {
    const text = typeof spec === 'string' ? spec : spec.query;
    if (text.includes('VectorDistance')) return { fetchAll: async () => ({ resources: semanticResults }) } as any;
    return realQuery(spec, opts);
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const seed = () =>
  thoughts().seed(
    { id: 'quirk', title: 'Character Quirk', content: 'Scraped up and bloody bandaids on their hands', tags: ['character', 'funny'], owner: OWNER, modifiedAt: '2026-11-09', contentVector: [1] },
    { id: 'perfume', content: 'You make less sense than a French perfume commercial', tags: ['funny'], owner: OWNER, modifiedAt: '2026-11-08', contentVector: [1] },
    { id: 'war', content: 'War is the continuation of policy by other means', owner: OWNER, modifiedAt: '2026-10-15', contentVector: [1] },
    { id: 'gone', content: 'bandaids deleted', owner: OWNER, deleted: true, contentVector: [1] },
    { id: 'other', content: 'bandaids belong to someone else', owner: 'b@example.com', contentVector: [1] },
  );

describe('helpers', () => {
  it('thoughtEmbeddingText prefixes the title when present', () => {
    expect(thoughtEmbeddingText({ title: 'T', content: 'C' })).toBe('T\n\nC');
    expect(thoughtEmbeddingText({ content: 'C' })).toBe('C');
  });

  it('searchWords lowercases, dedupes and drops 1-char tokens', () => {
    expect(searchWords('Bloody, bloody a BANDAIDS!')).toEqual(['bloody', 'bandaids']);
    expect(searchWords('   ')).toEqual([]);
  });

  it('keywordHits counts words found in title, content, or tags', () => {
    const t = { title: 'Quirk', content: 'bandaids', tags: ['Funny'] };
    expect(keywordHits(t, ['quirk', 'bandaids', 'funny', 'nope'])).toBe(3);
  });

  it('hasAllTags matches case-insensitively and passes with no tags', () => {
    expect(hasAllTags({ tags: ['Funny', 'x'] }, ['funny'])).toBe(true);
    expect(hasAllTags({ tags: ['Funny'] }, ['funny', 'x'])).toBe(false);
    expect(hasAllTags({}, [])).toBe(true);
  });
});

describe('backfillThoughtVectors', () => {
  it('embeds the owner’s live thoughts that lack a vector', async () => {
    thoughts().seed(
      { id: 'n1', title: 'T', content: 'needs one', owner: OWNER },
      { id: 'has', content: 'has one', owner: OWNER, contentVector: [9] },
      { id: 'del', content: 'deleted', owner: OWNER, deleted: true },
      { id: 'b', content: 'not mine', owner: 'b@example.com' },
    );
    expect(await backfillThoughtVectors(OWNER)).toBe(1);
    expect(embed).toHaveBeenCalledWith('T\n\nneeds one');
    expect(thoughts().get('n1')!.contentVector).toEqual([0.5, 0.5]);
    expect(thoughts().get('del')!.contentVector).toBeUndefined();
    expect(thoughts().get('b')!.contentVector).toBeUndefined();
  });

  it('stops at the first embedding failure', async () => {
    thoughts().seed(
      { id: 'n1', content: 'one', owner: OWNER },
      { id: 'n2', content: 'two', owner: OWNER },
    );
    embed.mockRejectedValue(new Error('down'));
    expect(await backfillThoughtVectors(OWNER)).toBe(0);
    expect(embed).toHaveBeenCalledTimes(1);
  });
});

describe('searchThoughts', () => {
  beforeEach(seed);

  it('ranks thoughts containing every word first, then semantic hits, then partial matches', async () => {
    semanticResults = [
      { id: 'war', content: 'War is the continuation of policy by other means', score: 0.6 },
      { id: 'quirk', title: 'Character Quirk', content: 'Scraped up and bloody bandaids on their hands', tags: ['character', 'funny'], score: 0.5 },
    ];
    const hits = await searchThoughts(OWNER, 'bloody bandaids');
    expect(hits.map((h) => [h.id, h.match])).toEqual([
      ['quirk', 'keyword'],
      ['war', 'semantic'],
    ]);
    expect(hits[1].score).toBe(0.6);
  });

  it('never returns deleted thoughts or another owner’s thoughts from keyword search', async () => {
    const hits = await searchThoughts(OWNER, 'bandaids');
    expect(hits.map((h) => h.id)).toEqual(['quirk']);
  });

  it('appends partial keyword matches after semantic hits', async () => {
    const hits = await searchThoughts(OWNER, 'french bandaids');
    expect(hits.map((h) => h.id).sort()).toEqual(['perfume', 'quirk']);
  });

  it('restricts every kind of hit to the requested tags', async () => {
    semanticResults = [{ id: 'war', content: 'War…', tags: [], score: 0.9 }];
    const hits = await searchThoughts(OWNER, 'sense', { tags: ['FUNNY'] });
    expect(hits.map((h) => h.id)).toEqual(['perfume']);
  });

  it('lists tagged thoughts newest first when there is no query', async () => {
    const hits = await searchThoughts(OWNER, '', { tags: ['funny'] });
    expect(hits.map((h) => h.id)).toEqual(['quirk', 'perfume']);
    expect(embed).not.toHaveBeenCalled();
  });

  it('falls back to keyword results when embedding the query fails', async () => {
    embed.mockRejectedValue(new Error('down'));
    const hits = await searchThoughts(OWNER, 'perfume');
    expect(hits.map((h) => h.id)).toEqual(['perfume']);
  });

  it('caps the number of results', async () => {
    semanticResults = [
      { id: 'war', content: 'w', score: 0.9 },
      { id: 'perfume', content: 'p', score: 0.8 },
    ];
    const hits = await searchThoughts(OWNER, 'anything', { topK: 1 });
    expect(hits).toHaveLength(1);
  });
});
