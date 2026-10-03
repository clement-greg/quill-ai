import request from 'supertest';

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
jest.mock('openai', () => {
  const create = jest.fn();
  return { AzureOpenAI: jest.fn(() => ({ chat: { completions: { create } } })), __create: create };
});

import chatSessionRoutes from './chat-sessions.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const create = jest.requireMock('openai').__create as jest.Mock;
const app = makeTestApp('/api/chat-sessions', chatSessionRoutes);

async function* chunks(...deltas: object[]) {
  for (const delta of deltas) yield { choices: [{ delta }] };
}

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-1',
  owner: USER_A,
  name: 'Talk about Elara',
  pinned: false,
  folderId: 'folder-1',
  seriesId: null,
  chapterId: null,
  messages: [],
  deleted: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  fake.reset();
  create.mockReset();
  fake.container('entities').seed(
    { id: 'ent-elara', owner: USER_A, name: 'Elara', type: 'PERSON', biography: 'A cartographer from Vell.' },
    { id: 'ent-bob', owner: USER_B, name: 'Bob', type: 'PERSON' },
    { id: 'ent-gone', owner: USER_A, name: 'Gone', type: 'THING', deleted: true },
  );
});

describe('attaching chat sessions to entities', () => {
  it('creates a session attached to an entity', async () => {
    const res = await request(app).post('/api/chat-sessions').send({ folderId: 'f', entityId: 'ent-elara' });

    expect(res.status).toBe(200);
    expect(res.body.entityId).toBe('ent-elara');
    expect(fake.container('chat-sessions').get(res.body.id)).toMatchObject({ entityId: 'ent-elara' });
  });

  it('defaults entityId to null when creating an unattached session', async () => {
    const res = await request(app).post('/api/chat-sessions').send({});
    expect(res.body.entityId).toBeNull();
  });

  it('refuses to create a session attached to another user\'s entity', async () => {
    const res = await request(app).post('/api/chat-sessions').send({ entityId: 'ent-bob' });
    expect(res.status).toBe(400);
    expect(fake.container('chat-sessions').all()).toEqual([]);
  });

  it('attaches and detaches an existing session, keeping its folder', async () => {
    fake.container('chat-sessions').seed(session());

    const attach = await request(app).put('/api/chat-sessions/sess-1').send({ entityId: 'ent-elara' });
    expect(attach.status).toBe(200);
    expect(fake.container('chat-sessions').get('sess-1')).toMatchObject({ entityId: 'ent-elara', folderId: 'folder-1' });

    const detach = await request(app).put('/api/chat-sessions/sess-1').send({ entityId: null });
    expect(detach.status).toBe(200);
    expect(fake.container('chat-sessions').get('sess-1')).toMatchObject({ entityId: null, folderId: 'folder-1' });
  });

  it('leaves the attachment alone when an update does not mention entityId', async () => {
    fake.container('chat-sessions').seed(session({ entityId: 'ent-elara' }));
    await request(app).put('/api/chat-sessions/sess-1').send({ name: 'Renamed' });
    expect(fake.container('chat-sessions').get('sess-1')).toMatchObject({ entityId: 'ent-elara', name: 'Renamed' });
  });

  it.each([
    ['another user\'s entity', 'ent-bob'],
    ['a deleted entity', 'ent-gone'],
    ['a missing entity', 'ent-nope'],
  ])('refuses to attach a session to %s', async (_label, entityId) => {
    fake.container('chat-sessions').seed(session());
    const res = await request(app).put('/api/chat-sessions/sess-1').send({ entityId });
    expect(res.status).toBe(400);
    expect(fake.container('chat-sessions').get('sess-1')!['entityId']).toBeUndefined();
  });

  it('lists only the requester\'s live sessions attached to the entity, newest first', async () => {
    fake.container('chat-sessions').seed(
      session({ id: 'old', entityId: 'ent-elara', updatedAt: '2026-01-01T00:00:00.000Z' }),
      session({ id: 'new', entityId: 'ent-elara', updatedAt: '2026-02-01T00:00:00.000Z' }),
      session({ id: 'other-entity', entityId: 'ent-x' }),
      session({ id: 'unattached' }),
      session({ id: 'archived', entityId: 'ent-elara', archived: true }),
      session({ id: 'deleted', entityId: 'ent-elara', deleted: true }),
      session({ id: 'bobs', entityId: 'ent-elara', owner: USER_B }),
    );

    const res = await request(app).get('/api/chat-sessions/by-entity/ent-elara');

    expect(res.status).toBe(200);
    expect(res.body.map((s: { id: string }) => s.id)).toEqual(['new', 'old']);
  });

  it('includes entityId in the session summaries list', async () => {
    fake.container('chat-sessions').seed(session({ entityId: 'ent-elara' }));
    const res = await request(app).get('/api/chat-sessions');
    expect(res.body[0]).toMatchObject({ id: 'sess-1', entityId: 'ent-elara' });
  });
});

describe('quick chat grounded in an attached entity', () => {
  const systemPrompt = () =>
    (create.mock.calls[0]![0] as { messages: { role: string; content: string }[] }).messages[0]!.content;

  async function quickChat(body: object) {
    create.mockImplementation(async () => chunks({ content: 'She maps the northern wastes.' }));
    return request(app)
      .post('/api/chat-sessions/quick-chat')
      .send({ messages: [{ role: 'user', content: 'What does she do?' }], ...body });
  }

  it('adds the entity\'s record to the system prompt', async () => {
    const res = await quickChat({ entityId: 'ent-elara' });

    expect(res.status).toBe(200);
    expect(systemPrompt()).toContain('ATTACHED ENTITY');
    expect(systemPrompt()).toContain('"Elara"');
    expect(systemPrompt()).toContain('A cartographer from Vell.');
  });

  it('adds nothing when no entity is attached', async () => {
    await quickChat({});
    expect(systemPrompt()).not.toContain('ATTACHED ENTITY');
  });

  it('never leaks another user\'s entity into the prompt', async () => {
    const res = await quickChat({ entityId: 'ent-bob' });
    expect(res.status).toBe(200);
    expect(systemPrompt()).not.toContain('ATTACHED ENTITY');
    expect(systemPrompt()).not.toContain('Bob');
  });
});
