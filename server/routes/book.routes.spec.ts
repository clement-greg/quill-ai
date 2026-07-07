import request from 'supertest';

jest.mock('../cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import bookRoutes from './book.routes';
import { makeTestApp, USER_A, USER_B, COLLABORATOR } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/books', bookRoutes);

function seed(): void {
  fake.reset();
  fake.container('series').seed(
    { id: 's-a', title: 'Alpha', owner: USER_A, collaborators: [COLLABORATOR] },
    { id: 's-b', title: 'Beta', owner: USER_B },
  );
  fake.container('books').seed(
    { id: 'b-a', title: 'Book A', seriesId: 's-a', owner: USER_A },
    { id: 'b-a-archived', title: 'Book A Old', seriesId: 's-a', owner: USER_A, archived: true },
    { id: 'b-b', title: 'Book B', seriesId: 's-b', owner: USER_B },
  );
}

beforeEach(seed);

describe('book routes — owner guard', () => {
  it('GET / returns only the requesting user’s active books', async () => {
    const res = await request(app).get('/api/books').set('x-test-user', USER_A);
    expect(res.status).toBe(200);
    expect(res.body.map((b: { id: string }) => b.id)).toEqual(['b-a']);
  });

  it('GET /archived returns only the requesting user’s archived books', async () => {
    const res = await request(app).get('/api/books/archived').set('x-test-user', USER_A);
    expect(res.body.map((b: { id: string }) => b.id)).toEqual(['b-a-archived']);
  });

  it('GET /:id hides another user’s book behind a 404', async () => {
    const own = await request(app).get('/api/books/b-a').set('x-test-user', USER_A);
    expect(own.status).toBe(200);

    const foreign = await request(app).get('/api/books/b-b').set('x-test-user', USER_A);
    expect(foreign.status).toBe(404);
  });

  it('GET /series/:seriesId lists books for owner and collaborator, 403 otherwise', async () => {
    const owner = await request(app).get('/api/books/series/s-a').set('x-test-user', USER_A);
    expect(owner.status).toBe(200);
    expect(owner.body.map((b: { id: string }) => b.id)).toEqual(['b-a']);

    const collab = await request(app).get('/api/books/series/s-a').set('x-test-user', COLLABORATOR);
    expect(collab.status).toBe(200);

    const stranger = await request(app).get('/api/books/series/s-b').set('x-test-user', USER_A);
    expect(stranger.status).toBe(403);
  });

  it('PATCH /:id/archive rejects a non-owner with 404', async () => {
    const res = await request(app).patch('/api/books/b-b/archive').set('x-test-user', USER_A);
    expect(res.status).toBe(404);
    expect(fake.container('books').get('b-b')!.archived).toBeUndefined();
  });

  it('POST / stamps the requesting user as owner and creator', async () => {
    const res = await request(app)
      .post('/api/books')
      .set('x-test-user', USER_A)
      .send({ id: 'b-new', title: 'New', seriesId: 's-a' });
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(USER_A);
    expect(res.body.createdBy).toBe(USER_A);
  });

  // Documents a known gap: these endpoints do no ownership check today.
  // When the guard is added, these start failing — remove `.failing` then.
  it.failing('PUT /:id rejects updates to another user’s book', async () => {
    const res = await request(app)
      .put('/api/books/b-b')
      .set('x-test-user', USER_A)
      .send({ title: 'Hijacked', seriesId: 's-b' });
    expect([403, 404]).toContain(res.status);
  });

  it.failing('DELETE /:id rejects deleting another user’s book', async () => {
    const res = await request(app).delete('/api/books/b-b').set('x-test-user', USER_A);
    expect([403, 404]).toContain(res.status);
  });

  it.failing('PATCH /reorder cannot modify another user’s books', async () => {
    await request(app)
      .patch('/api/books/reorder')
      .set('x-test-user', USER_A)
      .send([{ id: 'b-b', sortOrder: 99 }]);
    expect(fake.container('books').get('b-b')!.sortOrder).toBeUndefined();
  });
});
