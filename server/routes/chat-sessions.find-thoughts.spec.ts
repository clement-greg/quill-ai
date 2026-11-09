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
jest.mock('../services/thought-search', () => ({
  ...jest.requireActual('../services/thought-search'),
  searchThoughts: jest.fn(),
}));
jest.mock('openai', () => ({ AzureOpenAI: jest.fn(() => ({ responses: { create: jest.fn() } })) }));

import { Request } from 'express';
import { getFindThoughtsTool } from './chat-sessions.routes';
import { searchThoughts } from '../services/thought-search';

const search = searchThoughts as jest.Mock;
const req = { user: { email: 'a@example.com' } } as unknown as Request;
const tool = getFindThoughtsTool(req);
type Result = { toolResult: Record<string, any> };
const run = (args: Record<string, unknown>) => tool.execute(args) as Promise<Result>;

beforeEach(() => {
  search.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('find_thoughts tool', () => {
  it('searches the caller’s thoughts and returns linked, trimmed results', async () => {
    search.mockResolvedValue([
      { id: 'q 1', title: 'Character Quirk', content: 'x'.repeat(500), tags: ['funny'], modifiedAt: '2026-11-09', match: 'semantic', score: 0.7 },
    ]);
    const { toolResult } = await run({ query: 'bandaids', tags: [' Funny '] });

    expect(search).toHaveBeenCalledWith('a@example.com', 'bandaids', { topK: 8, tags: ['Funny'] });
    expect(toolResult['found']).toBe(true);
    const [hit] = toolResult['thoughts'];
    expect(hit.link).toBe('/thoughts?open=q%201');
    expect(hit.title).toBe('Character Quirk');
    expect(hit.excerpt).toHaveLength(401);
    expect(hit.excerpt.endsWith('…')).toBe(true);
  });

  it('asks for a query when given neither text nor tags', async () => {
    const { toolResult } = await run({ query: '  ' });
    expect(toolResult['found']).toBe(false);
    expect(search).not.toHaveBeenCalled();
  });

  it('allows a tags-only lookup', async () => {
    search.mockResolvedValue([]);
    const { toolResult } = await run({ query: '', tags: ['funny'] });
    expect(search).toHaveBeenCalledWith('a@example.com', '', { topK: 8, tags: ['funny'] });
    expect(toolResult['message']).toContain('funny');
  });

  it('reports no matches, and failures, without throwing', async () => {
    search.mockResolvedValue([]);
    expect((await run({ query: 'nothing' })).toolResult['found']).toBe(false);

    search.mockRejectedValue(new Error('boom'));
    const failed = await run({ query: 'x' });
    expect(failed.toolResult['found']).toBe(false);
    expect(failed.toolResult['message']).toContain('failed');
  });
});
