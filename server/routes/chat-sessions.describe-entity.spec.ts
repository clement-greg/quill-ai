jest.mock('../config');
jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('../services/chapter-chunks', () => ({
  searchChapterChunks: jest.fn(async () => []),
  hybridSearchChapterChunks: jest.fn(async () => []),
  reindexChapterChunks: jest.fn(async () => undefined),
}));
jest.mock('../services/timeline-event-chunks', () => ({ searchTimelineEvents: jest.fn(async () => []) }));
jest.mock('../services/image-generation', () => ({ generateImage: jest.fn() }));
jest.mock('../services/chapter-ai-context', () => ({ buildChapterContextPrompt: jest.fn() }));
jest.mock('../services/chapter-drafting-context', () => ({
  buildChapterDraftingContext: jest.fn(),
  generateChapterBeatSheet: jest.fn(),
}));
jest.mock('../services/content-sanitize', () => ({ sanitizeForModeration: jest.fn(async (t: string) => t) }));
jest.mock('openai', () => {
  const create = jest.fn();
  return {
    AzureOpenAI: jest.fn(() => ({ responses: { create: jest.fn() }, chat: { completions: { create } } })),
    __create: create,
  };
});

import { Request } from 'express';
import { contentFilterCategories, describeRecordVariants, getDescribeEntityTool } from './chat-sessions.routes';
import { FakeCosmos } from '../testing/fake-cosmos';
import { USER_A } from '../testing/test-app';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const create = jest.requireMock('openai').__create as jest.Mock;
const req = { user: { email: USER_A } } as unknown as Request;
type Result = { toolResult: Record<string, any> };
const run = () => getDescribeEntityTool(req).execute({ entityName: 'Jim Anson' }) as Promise<Result>;

const promptFiltered = () =>
  Object.assign(new Error('filtered'), {
    code: 'content_filter',
    error: { innererror: { content_filter_result: { violence: { filtered: true, severity: 'medium' }, hate: { filtered: false } } } },
  });
const ok = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
const sentRecord = (call: number) => (create.mock.calls[call][0].messages[1].content[0].text as string);

beforeEach(() => {
  fake.reset();
  create.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  fake.container('entities').seed(
    { id: 'ent-jim', owner: USER_A, name: 'Jim Anson', type: 'PERSON', biography: 'Co-owner of a gun shop.' },
    { id: 'ent-mary', owner: USER_A, name: 'Mary Anson', type: 'PERSON' },
  );
  fake.container('timeline-events').seed(
    { id: 'ev-1', owner: USER_A, entityId: 'ent-jim', name: 'Jim killed in a robbery', description: 'Shot during the robbery.' },
  );
  fake.container('entity-relationships').seed(
    { id: 'rel-1', owner: USER_A, sourceEntityId: 'ent-jim', targetEntityId: 'ent-mary', relationshipType: 'spouse', description: 'Married 53 years.' },
  );
});

afterEach(() => jest.restoreAllMocks());

describe('describe_entity content-filter handling', () => {
  it('retries without violent timeline events when the prompt is filtered', async () => {
    create.mockRejectedValueOnce(promptFiltered()).mockResolvedValueOnce(ok('Jim is a weathered shopkeeper.'));

    const { toolResult } = await run();

    expect(toolResult['description']).toBe('Jim is a weathered shopkeeper.');
    expect(toolResult['note']).toMatch(/left out/);
    expect(sentRecord(0)).toContain('Shot during the robbery');
    expect(sentRecord(1)).not.toContain('Shot during the robbery');
  });

  it('treats a completion cut off by the filter as blocked, not as a description', async () => {
    create
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'content_filter', message: { content: 'Jim is hel' } }] })
      .mockResolvedValueOnce(ok('Full description.'));

    const { toolResult } = await run();

    expect(toolResult['description']).toBe('Full description.');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('reports the flagged categories when every attempt is filtered', async () => {
    create.mockRejectedValue(promptFiltered());

    const { toolResult } = await run();

    expect(create).toHaveBeenCalledTimes(2);
    expect(toolResult['filtered']).toBe(true);
    expect(toolResult['categories']).toEqual(['violence (medium)']);
    expect(toolResult['message']).toContain('violence (medium)');
  });

  it('does not retry on non-filter errors', async () => {
    create.mockRejectedValue(new Error('boom'));

    const { toolResult } = await run();

    expect(create).toHaveBeenCalledTimes(1);
    expect(toolResult['message']).toMatch(/try again/);
  });
});

describe('describeRecordVariants', () => {
  it('drops timeline events, then relationship details, then relationships', () => {
    const record = {
      name: 'Jim',
      biography: 'Shopkeeper.',
      timelineEvents: [{ name: 'Killed' }],
      relationships: [{ partner: 'Mary', type: 'spouse', description: 'Married 53 years.' }],
    };
    expect(describeRecordVariants(record)).toEqual([
      record,
      { name: 'Jim', biography: 'Shopkeeper.', relationships: [{ partner: 'Mary', type: 'spouse' }] },
      { name: 'Jim', biography: 'Shopkeeper.' },
    ]);
  });

  it('returns only the full record when there is nothing to strip', () => {
    expect(describeRecordVariants({ name: 'A', biography: 'b' })).toEqual([{ name: 'A', biography: 'b' }]);
  });
});

describe('contentFilterCategories', () => {
  it('reads filtered choices', () => {
    expect(contentFilterCategories({ content_filter_results: { sexual: { filtered: true } } })).toEqual(['sexual']);
  });
  it('returns nothing for unknown shapes', () => {
    expect(contentFilterCategories(undefined)).toEqual([]);
  });
});
