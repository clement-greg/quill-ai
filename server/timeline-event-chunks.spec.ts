import { TimelineEvent } from '../shared/models/timeline-event.model';

jest.mock('./cosmos', () => {
  const itemApi = { read: jest.fn(), delete: jest.fn(), replace: jest.fn() };
  const container = {
    items: { query: jest.fn(), upsert: jest.fn() },
    item: jest.fn(() => itemApi),
    __itemApi: itemApi,
  };
  return { getContainer: () => container };
});

jest.mock('./embeddings', () => ({
  generateEmbedding: jest.fn(),
}));

import { getContainer } from './cosmos';
import { generateEmbedding } from './embeddings';
import {
  indexTimelineEvent,
  deleteTimelineEventChunk,
  deleteTimelineEventChunksForEntity,
  searchTimelineEvents,
} from './timeline-event-chunks';

/* eslint-disable @typescript-eslint/no-explicit-any */
const container = getContainer('timeline-event-chunks') as any;
const embedMock = generateEmbedding as jest.Mock;

const OWNER = 'author@example.com';

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'ev-1',
    entityId: 'ent-1',
    seriesId: 's-1',
    name: 'A fatal fall',
    owner: OWNER,
    ...overrides,
  } as TimelineEvent;
}

function stubQueryResults(resources: unknown[]): void {
  container.items.query.mockReturnValue({ fetchAll: async () => ({ resources }) });
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  stubQueryResults([]);
  embedMock.mockResolvedValue([0.1, 0.2]);
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('indexTimelineEvent', () => {
  it('embeds the entity-prefixed event text and upserts the chunk', async () => {
    const event = makeEvent({
      timeframe: 'Year 3',
      description: 'He slips on the cliff path.',
      location: 'The Shattered Cliffs',
      chapterId: 'ch-7',
    });
    await indexTimelineEvent(event, 'Jim');

    const expectedContent =
      'Jim: A fatal fall (Year 3) — He slips on the cliff path. [Location: The Shattered Cliffs]';
    expect(embedMock).toHaveBeenCalledWith(expectedContent);
    expect(container.items.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ev-1',
        eventId: 'ev-1',
        entityId: 'ent-1',
        entityName: 'Jim',
        seriesId: 's-1',
        chapterId: 'ch-7',
        owner: OWNER,
        content: expectedContent,
        contentVector: [0.1, 0.2],
      }),
    );
  });

  it('omits absent optional fields from the embedded text', async () => {
    await indexTimelineEvent(makeEvent(), 'Jim');
    expect(embedMock).toHaveBeenCalledWith('Jim: A fatal fall');
  });

  it('never throws when embedding fails, and skips the upsert', async () => {
    embedMock.mockRejectedValue(new Error('embedding down'));
    await expect(indexTimelineEvent(makeEvent(), 'Jim')).resolves.toBeUndefined();
    expect(container.items.upsert).not.toHaveBeenCalled();
  });
});

describe('deleteTimelineEventChunk', () => {
  it('deletes the chunk by event id within the entity partition', async () => {
    await deleteTimelineEventChunk('ev-1', 'ent-1');
    expect(container.item).toHaveBeenCalledWith('ev-1', 'ent-1');
    expect(container.__itemApi.delete).toHaveBeenCalledTimes(1);
  });

  it('silently ignores a 404 (nothing was indexed)', async () => {
    container.__itemApi.delete.mockRejectedValue({ code: 404 });
    await expect(deleteTimelineEventChunk('ev-1', 'ent-1')).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs but does not throw on other failures', async () => {
    container.__itemApi.delete.mockRejectedValue(new Error('cosmos down'));
    await expect(deleteTimelineEventChunk('ev-1', 'ent-1')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('deleteTimelineEventChunksForEntity', () => {
  it('deletes every chunk in the entity partition', async () => {
    stubQueryResults([{ id: 'ev-1' }, { id: 'ev-2' }]);
    await deleteTimelineEventChunksForEntity('ent-1');
    expect(container.items.query).toHaveBeenCalledWith(expect.anything(), { partitionKey: 'ent-1' });
    expect(container.item).toHaveBeenCalledWith('ev-1', 'ent-1');
    expect(container.item).toHaveBeenCalledWith('ev-2', 'ent-1');
    expect(container.__itemApi.delete).toHaveBeenCalledTimes(2);
  });
});

describe('searchTimelineEvents', () => {
  function capturedQuery(): { query: string; parameters: { name: string; value: unknown }[] } {
    return container.items.query.mock.calls[0][0];
  }

  it('returns matching events scoped to the owner', async () => {
    const hits = [{ eventId: 'ev-1', entityId: 'ent-1', entityName: 'Jim', content: 'Jim: A fatal fall', score: 0.9 }];
    stubQueryResults(hits);

    const results = await searchTimelineEvents("Jim's fate", {}, OWNER);
    expect(results).toEqual(hits);

    const { query, parameters } = capturedQuery();
    expect(query).toContain('SELECT TOP 5');
    expect(query).toMatch(/c\.owner = @_owner\s+ORDER BY/);
    expect(parameters).toContainEqual({ name: '@_owner', value: OWNER });
  });

  it('clamps topK to the 1..50 range', async () => {
    await searchTimelineEvents('q', { topK: 200 }, OWNER);
    expect(capturedQuery().query).toContain('SELECT TOP 50');
  });

  it('applies series and entity filters', async () => {
    await searchTimelineEvents('q', { seriesId: 's-9', entityId: 'ent-9' }, OWNER);
    const { query, parameters } = capturedQuery();
    expect(query).toContain('c.seriesId = @seriesId AND c.entityId = @entityId');
    expect(parameters).toContainEqual({ name: '@seriesId', value: 's-9' });
    expect(parameters).toContainEqual({ name: '@entityId', value: 'ent-9' });
  });

  it('returns an empty array when the search fails', async () => {
    embedMock.mockRejectedValue(new Error('embedding down'));
    expect(await searchTimelineEvents('q', {}, OWNER)).toEqual([]);
  });
});
