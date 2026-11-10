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

import tasksRoutes from './tasks.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/tasks', tasksRoutes);

/** Makes the next LLM call return this JSON object. */
function llmReturns(obj: unknown): void {
  create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

const task = (over: { id: string } & Record<string, unknown>) => ({
  docType: 'task',
  bookId: 'book-1',
  seriesId: 'series-1',
  title: 'A task',
  completed: false,
  owner: USER_A,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

function seed(): void {
  fake.reset();
  fake.container('books').seed(
    { id: 'book-1', title: 'Lithium', seriesId: 'series-1', owner: USER_A },
    { id: 'book-2', title: 'Cobalt', seriesId: 'series-1', owner: USER_A },
    { id: 'book-b', title: 'Bob’s Book', seriesId: 'series-b', owner: USER_B },
    { id: 'book-archived', title: 'Old', seriesId: 'series-1', owner: USER_A, archived: true },
  );
  fake.container('entities').seed(
    { id: 'ent-dale', name: 'Dale Harper', firstName: 'Dale', type: 'PERSON', seriesId: 'series-1', owner: USER_A },
    { id: 'ent-mill', name: 'The Mill', type: 'PLACE', seriesId: 'series-1', owner: USER_A },
  );
  fake.container('chapters').seed(
    { id: 'ch-1', title: 'Arrival', bookId: 'book-1', sortOrder: 1, owner: USER_A },
    { id: 'ch-2', title: 'Flood', bookId: 'book-1', sortOrder: 2, owner: USER_A },
  );
  fake.container('thought-items').seed(
    { id: 'thought-1', content: 'Just a thought', owner: USER_A },
    task({ id: 'task-late', title: 'Late one', dueDate: '2020-01-01' }),
    task({ id: 'task-soon', title: 'Soon one', dueDate: '2099-01-01' }),
    task({ id: 'task-undated', title: 'Someday', bookId: 'book-2' }),
    task({ id: 'task-done', title: 'Done one', completed: true, completedAt: '2026-02-01T00:00:00Z' }),
    task({ id: 'task-deleted', title: 'Gone', deleted: true }),
    task({ id: 'task-bob', title: 'Bob task', owner: USER_B, bookId: 'book-b' }),
  );
}

beforeEach(() => {
  seed();
  create.mockReset();
});

const ids = (body: { items: { id: string }[] }) => body.items.map(t => t.id);

describe('GET /api/tasks', () => {
  it('lists only the caller’s open tasks, most urgent first, never thoughts', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual(['task-late', 'task-soon', 'task-undated']);
    expect(res.body.items[0].bookTitle).toBe('Lithium');
    expect(res.body.books.map((b: { title: string }) => b.title)).toEqual(['Cobalt', 'Lithium']);
  });

  it('filters by status, book and search words', async () => {
    expect(ids((await request(app).get('/api/tasks?status=completed')).body)).toEqual(['task-done']);
    expect(ids((await request(app).get('/api/tasks?status=all')).body)).toHaveLength(4);
    expect(ids((await request(app).get('/api/tasks?bookId=book-2')).body)).toEqual(['task-undated']);
    expect(ids((await request(app).get('/api/tasks?q=soon')).body)).toEqual(['task-soon']);
  });

  it('summarizes open, overdue and next tasks', async () => {
    const res = await request(app).get('/api/tasks/summary?tz=America/Denver&limit=2');
    expect(res.body.open).toBe(3);
    expect(res.body.overdue).toBe(1);
    expect(res.body.next.map((t: { id: string }) => t.id)).toEqual(['task-late', 'task-soon']);
  });
});

describe('reading and changing one task', () => {
  it('404s for another user’s task, a deleted task, and a thought', async () => {
    expect((await request(app).get('/api/tasks/task-bob')).status).toBe(404);
    expect((await request(app).get('/api/tasks/task-deleted')).status).toBe(404);
    expect((await request(app).get('/api/tasks/thought-1')).status).toBe(404);
    expect((await request(app).patch('/api/tasks/thought-1/complete').send({})).status).toBe(404);
  });

  it('completes and reopens, recording the chapter', async () => {
    const done = await request(app).patch('/api/tasks/task-soon/complete').send({ chapterId: 'ch-2' });
    expect(done.body.completed).toBe(true);
    expect(done.body.completedAt).toBeTruthy();
    expect(done.body.completedChapterId).toBe('ch-2');

    const reopened = await request(app).patch('/api/tasks/task-soon/complete').send({ completed: false });
    expect(reopened.body.completed).toBe(false);
    expect(reopened.body.completedAt).toBeUndefined();
    expect(reopened.body.completedChapterId).toBeUndefined();
  });

  it('soft-deletes and restores', async () => {
    expect((await request(app).delete('/api/tasks/task-soon')).status).toBe(204);
    expect(fake.container('thought-items').get('task-soon')?.['deleted']).toBe(true);
    await request(app).patch('/api/tasks/task-soon/restore');
    expect(fake.container('thought-items').get('task-soon')?.['deleted']).toBe(false);
  });
});

describe('POST /api/tasks', () => {
  it('validates title, book and date', async () => {
    expect((await request(app).post('/api/tasks').send({ bookId: 'book-1' })).status).toBe(400);
    expect((await request(app).post('/api/tasks').send({ title: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/tasks').send({ title: 'x', bookId: 'book-b' })).status).toBe(400);
    expect((await request(app).post('/api/tasks').send({ title: 'x', bookId: 'book-1', dueDate: '2026-02-30' })).status).toBe(400);
  });

  it('stores a task in the shared container and links its body via the model', async () => {
    llmReturns({
      links: [
        { ref: 'E1', text: 'Dale' },
        { ref: 'C1', text: 'chapter 2' }, // wrong ref: the number in the text wins
        { ref: 'E2', text: 'not in the body' },
        { ref: 'E9', text: 'mill' },
      ],
    });
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Flood scene', body: 'Have Dale reach the mill in chapter 2', bookId: 'book-1', dueDate: '2026-03-06' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ docType: 'task', bookId: 'book-1', seriesId: 'series-1', completed: false, owner: USER_A, dueDate: '2026-03-06' });
    expect(res.body.links).toEqual([
      { kind: 'entity', id: 'ent-dale', text: 'Dale', name: 'Dale Harper' },
      { kind: 'chapter', id: 'ch-2', text: 'chapter 2', name: 'Flood' },
    ]);
    expect(fake.container('thought-items').get(res.body.id)?.['docType']).toBe('task');
  });

  it('falls back to name matching when the model fails', async () => {
    create.mockRejectedValueOnce(new Error('model down'));
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'x', body: 'Dale Harper visits The Mill in chapter 1', bookId: 'book-1' });
    expect(res.status).toBe(201);
    expect(res.body.links.map((l: { id: string }) => l.id).sort()).toEqual(['ch-1', 'ent-dale', 'ent-mill']);
  });

  it('skips the model when there is no body', async () => {
    const res = await request(app).post('/api/tasks').send({ title: 'x', bookId: 'book-1' });
    expect(res.body.links).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/tasks/:id', () => {
  it('relinks only when the body or book changes, and clears a due date', async () => {
    const res = await request(app).put('/api/tasks/task-soon').send({ title: 'Renamed', dueDate: null });
    expect(res.body.title).toBe('Renamed');
    expect(res.body.dueDate).toBeUndefined();
    expect(create).not.toHaveBeenCalled();

    llmReturns({ links: [{ ref: 'E1', text: 'Dale' }] });
    const relinked = await request(app).put('/api/tasks/task-soon').send({ body: 'Ask Dale' });
    expect(relinked.body.links).toEqual([{ kind: 'entity', id: 'ent-dale', text: 'Dale', name: 'Dale Harper' }]);
  });
});

describe('POST /api/tasks/check-chapter', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    chapterId: 'ch-2',
    previousContent: '<p>The river rose.</p>',
    content: '<p>The river rose.</p><p>Dale found the letter under the mill wheel.</p>',
    ...over,
  });

  it('returns confident candidates from the book’s open tasks', async () => {
    llmReturns({
      fulfilled: [
        { task: 'T1', confidence: 0.9, reason: 'Dale finds the letter.' },
        { task: 'T2', confidence: 0.3, reason: 'weak' },
        { task: 'T7', confidence: 0.9, reason: 'no such task' },
      ],
    });
    const res = await request(app).post('/api/tasks/check-chapter').send(body());
    expect(res.body.candidates).toEqual([{ taskId: 'task-late', title: 'Late one', reason: 'Dale finds the letter.' }]);
    const prompt = create.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('Dale found the letter');
    expect(prompt).not.toContain('Someday'); // other book
    expect(prompt).not.toContain('Done one');
  });

  it('skips the model when nothing changed or every task is excluded', async () => {
    expect((await request(app).post('/api/tasks/check-chapter').send(body({ content: '<p>The river rose.</p>' }))).body.candidates).toEqual([]);
    const excluded = await request(app).post('/api/tasks/check-chapter').send(body({ excludeTaskIds: ['task-late', 'task-soon'] }));
    expect(excluded.body.candidates).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it('requires the fields', async () => {
    expect((await request(app).post('/api/tasks/check-chapter').send({ chapterId: 'ch-2' })).status).toBe(400);
  });
});

describe('POST /api/tasks/voice', () => {
  it('creates the task in the book the model picked', async () => {
    llmReturns({ title: 'Tighten the flood scene', body: '', book: 'B2', dueDate: '2026-03-06' });
    const res = await request(app).post('/api/tasks/voice').send({ text: 'tighten the flood scene in lithium by friday', tz: 'America/Denver' });
    expect(res.body.saved).toBe(true);
    expect(res.body.task).toMatchObject({ bookId: 'book-1', title: 'Tighten the flood scene', dueDate: '2026-03-06' });
    expect(res.body.spoken).toContain('Lithium');
  });

  it('asks for the book when it can’t tell, then uses the named one', async () => {
    llmReturns({ title: 'Name the ferry', book: null, dueDate: null });
    const ask = await request(app).post('/api/tasks/voice').send({ text: 'name the ferry' });
    expect(ask.body).toMatchObject({ saved: false, needsBook: true, books: ['Cobalt', 'Lithium'] });

    llmReturns({ title: 'Name the ferry', book: null, dueDate: null });
    const saved = await request(app).post('/api/tasks/voice').send({ text: 'name the ferry', bookName: 'cobalt' });
    expect(saved.body.task.bookId).toBe('book-2');
  });
});
