import request from 'supertest';

const create = jest.fn();
jest.mock('openai', () => ({
  AzureOpenAI: jest.fn(() => ({ chat: { completions: { create } } })),
}));
jest.mock('../services/ai-models', () => ({
  modelFor: jest.fn(async () => 'test-model'),
}));
jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('../services/chapter-chunks', () => ({
  reindexChapterChunks: jest.fn(),
  deleteChapterChunks: jest.fn(),
}));
jest.mock('../services/chapter-summary', () => ({
  refreshChapterSummary: jest.fn(),
}));

import chapterRoutes from './chapter.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';
import { markSpans } from '../services/dialogue-speakers';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/chapters', chapterRoutes);

const PARA = '"Hi," Ann said. "Hello," said Bob.';
const SPANS = [{ start: 0, end: 5 }, { start: 16, end: 24 }];

function modelReplies(payload: unknown): void {
  create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(payload) } }] });
}

beforeEach(() => {
  create.mockReset();
  fake.reset();
  fake.container('series').seed({ id: 's-a', title: 'Alpha', owner: USER_A });
  fake.container('books').seed({ id: 'b-a', title: 'Book A', seriesId: 's-a', owner: USER_A });
  fake.container('entities').seed(
    { id: 'ann', name: 'Ann', type: 'PERSON', seriesId: 's-a', owner: USER_A },
    { id: 'bob', name: 'Bob', type: 'PERSON', seriesId: 's-a', owner: USER_A },
    { id: 'gone', name: 'Gone', type: 'PERSON', seriesId: 's-a', owner: USER_A, archived: true },
    { id: 'town', name: 'Town', type: 'PLACE', seriesId: 's-a', owner: USER_A },
  );
  fake.container('chapters').seed({
    id: 'ch-a', title: 'One', bookId: 'b-a', owner: USER_A,
    dialogue: { kept: ['ann'], stale: ['bob'] },
  });
});

describe('POST /api/chapters/:id/dialogue', () => {
  it('attributes only new paragraphs, keeps known ones and drops stale ones', async () => {
    modelReplies({ paragraphs: [{ id: 'P1', speakers: ['C1', 'C2'] }] });
    const res = await request(app).post('/api/chapters/ch-a/dialogue').set('x-test-user', USER_A).send({
      keys: ['kept', 'new'],
      pending: [
        { key: 'kept', text: PARA, spans: SPANS },
        { key: 'new', text: PARA, spans: SPANS, context: 'They met at the gate.' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.dialogue).toEqual({ kept: ['ann'], new: ['ann', 'bob'] });
    expect(create).toHaveBeenCalledTimes(1);
    const prompt = create.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('C1: Ann');
    expect(prompt).not.toContain('Gone');
    expect(prompt).not.toContain('Town');
    expect(prompt).toContain('They met at the gate.');
    const stored = fake.container('chapters').get('ch-a') as unknown as { dialogue: unknown };
    expect(stored.dialogue).toEqual({ kept: ['ann'], new: ['ann', 'bob'] });
  });

  it('does not call the model when nothing is pending', async () => {
    const res = await request(app).post('/api/chapters/ch-a/dialogue').set('x-test-user', USER_A)
      .send({ keys: ['kept'], pending: [] });
    expect(res.body.dialogue).toEqual({ kept: ['ann'] });
    expect(create).not.toHaveBeenCalled();
  });

  it('stores null speakers for a reply that does not fit, so it is not asked again', async () => {
    modelReplies({ paragraphs: [{ id: 'P1', speakers: ['C1'] }] });
    const res = await request(app).post('/api/chapters/ch-a/dialogue').set('x-test-user', USER_A)
      .send({ keys: ['new'], pending: [{ key: 'new', text: PARA, spans: SPANS }] });
    expect(res.body.dialogue).toEqual({ new: [null, null] });
  });

  it('leaves paragraphs out when the model call fails, so the next save retries', async () => {
    create.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/chapters/ch-a/dialogue').set('x-test-user', USER_A)
      .send({ keys: ['kept', 'new'], pending: [{ key: 'new', text: PARA, spans: SPANS }] });
    expect(res.body.dialogue).toEqual({ kept: ['ann'] });
  });

  it('rejects malformed spans and hides other users’ chapters', async () => {
    const bad = await request(app).post('/api/chapters/ch-a/dialogue').set('x-test-user', USER_A)
      .send({ keys: ['x'], pending: [{ key: 'x', text: 'short', spans: [{ start: 0, end: 99 }] }] });
    expect(bad.status).toBe(400);
    const other = await request(app).post('/api/chapters/ch-a/dialogue').set('x-test-user', USER_B)
      .send({ keys: [], pending: [] });
    expect(other.status).toBe(404);
  });
});

describe('PATCH /api/chapters/:id/dialogue', () => {
  const patch = (body: unknown, user = USER_A) =>
    request(app).patch('/api/chapters/ch-a/dialogue').set('x-test-user', user).send(body as object);

  it('changes one line\'s speaker and leaves the rest', async () => {
    fake.container('chapters').seed({ id: 'ch-a', title: 'One', bookId: 'b-a', owner: USER_A, dialogue: { k: ['ann', 'bob'] } });
    const res = await patch({ key: 'k', index: 1, entityId: 'ann' });
    expect(res.status).toBe(200);
    expect(res.body.dialogue).toEqual({ k: ['ann', 'ann'] });
    expect((fake.container('chapters').get('ch-a') as unknown as { dialogue: unknown }).dialogue).toEqual({ k: ['ann', 'ann'] });
    expect(create).not.toHaveBeenCalled();
  });

  it('can set a line to the narration voice', async () => {
    const res = await patch({ key: 'kept', index: 0, entityId: null });
    expect(res.body.dialogue.kept).toEqual([null]);
  });

  it('refuses lines that are not attributed, out-of-range indexes and non-characters', async () => {
    expect((await patch({ key: 'nope', index: 0, entityId: 'ann' })).status).toBe(409);
    expect((await patch({ key: 'kept', index: 3, entityId: 'ann' })).status).toBe(409);
    expect((await patch({ key: 'kept', index: 0, entityId: 'town' })).status).toBe(400);
    expect((await patch({ key: 'kept', index: 0, entityId: 'missing' })).status).toBe(400);
    expect((await patch({ key: 'kept', index: -1, entityId: 'ann' })).status).toBe(400);
  });

  it('hides other users’ chapters', async () => {
    expect((await patch({ key: 'kept', index: 0, entityId: 'ann' }, USER_B)).status).toBe(404);
  });
});

describe('PUT /api/chapters/:id keeps stored dialogue', () => {
  it('ignores the client’s copy', async () => {
    const res = await request(app).put('/api/chapters/ch-a').set('x-test-user', USER_A)
      .send({ id: 'ch-a', title: 'One', bookId: 'b-a', owner: USER_A, dialogue: { old: [] } });
    expect(res.status).toBe(200);
    expect(res.body.dialogue).toEqual({ kept: ['ann'], stale: ['bob'] });
  });
});

describe('markSpans', () => {
  it('wraps each span in numbered markers', () => {
    expect(markSpans(PARA, SPANS)).toBe('[[1]]"Hi,"[[/1]] Ann said. [[2]]"Hello,"[[/2]] said Bob.');
  });
});
