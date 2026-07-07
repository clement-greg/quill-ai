import request from 'supertest';

jest.mock('../cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('../chapter-chunks', () => ({
  reindexChapterChunks: jest.fn(),
  deleteChapterChunks: jest.fn(),
}));
jest.mock('../chapter-summary', () => ({
  refreshChapterSummary: jest.fn(),
}));

import chapterRoutes from './chapter.routes';
import { makeTestApp, USER_A, USER_B, COLLABORATOR } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/chapters', chapterRoutes);

function seed(): void {
  fake.reset();
  fake.container('series').seed(
    { id: 's-a', title: 'Alpha', owner: USER_A, collaborators: [COLLABORATOR] },
    { id: 's-b', title: 'Beta', owner: USER_B },
  );
  fake.container('books').seed(
    { id: 'b-a', title: 'Book A', seriesId: 's-a', owner: USER_A },
    { id: 'b-b', title: 'Book B', seriesId: 's-b', owner: USER_B },
  );
  fake.container('chapters').seed(
    { id: 'ch-a', title: 'Alice One', bookId: 'b-a', owner: USER_A },
    { id: 'ch-a-archived', title: 'Alice Old', bookId: 'b-a', owner: USER_A, archived: true },
    { id: 'ch-b', title: 'Bob One', bookId: 'b-b', owner: USER_B },
  );
}

beforeEach(seed);

describe('chapter routes — owner guard', () => {
  it('GET / returns only the requesting user’s active chapters', async () => {
    const res = await request(app).get('/api/chapters').set('x-test-user', USER_A);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(['ch-a']);
  });

  it('GET /archived returns only the requesting user’s archived chapters', async () => {
    const res = await request(app).get('/api/chapters/archived').set('x-test-user', USER_A);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(['ch-a-archived']);
  });

  it('GET /:id returns an owned chapter', async () => {
    const res = await request(app).get('/api/chapters/ch-a').set('x-test-user', USER_A);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('ch-a');
  });

  it('GET /:id hides another user’s chapter behind a 404', async () => {
    const res = await request(app).get('/api/chapters/ch-b').set('x-test-user', USER_A);
    expect(res.status).toBe(404);
    expect(res.body.id).toBeUndefined();
  });

  it('GET /:id allows a series collaborator to read a chapter', async () => {
    const res = await request(app).get('/api/chapters/ch-a').set('x-test-user', COLLABORATOR);
    expect(res.status).toBe(200);
  });

  it('GET /book/:bookId lists chapters for the owner and collaborators, 403 otherwise', async () => {
    const owner = await request(app).get('/api/chapters/book/b-a').set('x-test-user', USER_A);
    expect(owner.status).toBe(200);
    expect(owner.body.map((c: { id: string }) => c.id)).toEqual(['ch-a']);

    const collab = await request(app).get('/api/chapters/book/b-a').set('x-test-user', COLLABORATOR);
    expect(collab.status).toBe(200);

    const stranger = await request(app).get('/api/chapters/book/b-b').set('x-test-user', USER_A);
    expect(stranger.status).toBe(403);
  });

  it('PATCH /:id/archive rejects a user without series access', async () => {
    const res = await request(app).patch('/api/chapters/ch-b/archive').set('x-test-user', USER_A);
    expect(res.status).toBe(403);
    expect(fake.container('chapters').get('ch-b')!.archived).toBeUndefined();
  });

  it('POST / stamps the requesting user as owner and creator', async () => {
    const res = await request(app)
      .post('/api/chapters')
      .set('x-test-user', USER_A)
      .send({ id: 'ch-new', title: 'New', bookId: 'b-a' });
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(USER_A);
    expect(res.body.createdBy).toBe(USER_A);
  });

  // Documents a known gap: these endpoints do no ownership check today.
  // When the guard is added, these start failing — remove `.failing` then.
  it.failing('PUT /:id rejects updates to another user’s chapter', async () => {
    const res = await request(app)
      .put('/api/chapters/ch-b')
      .set('x-test-user', USER_A)
      .send({ title: 'Hijacked', bookId: 'b-b' });
    expect([403, 404]).toContain(res.status);
  });

  it.failing('DELETE /:id rejects deleting another user’s chapter', async () => {
    const res = await request(app).delete('/api/chapters/ch-b').set('x-test-user', USER_A);
    expect([403, 404]).toContain(res.status);
  });

  it.failing('PATCH /reorder cannot modify another user’s chapters', async () => {
    await request(app)
      .patch('/api/chapters/reorder')
      .set('x-test-user', USER_A)
      .send([{ id: 'ch-b', sortOrder: 99 }]);
    expect(fake.container('chapters').get('ch-b')!.sortOrder).toBeUndefined();
  });
});
