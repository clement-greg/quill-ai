import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import bookNotesRoutes from './book-notes.routes';
import { makeTestApp, USER_A, USER_B, COLLABORATOR } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/book-notes', bookNotesRoutes);

function seed(): void {
  fake.reset();
  fake.container('series').seed(
    { id: 's-a', owner: USER_A, collaborators: [COLLABORATOR] },
    { id: 's-b', owner: USER_B },
  );
  fake.container('books').seed(
    { id: 'b-a', seriesId: 's-a', owner: USER_A },
    { id: 'b-b', seriesId: 's-b', owner: USER_B },
  );
  fake.container('book-notes').seed(
    { id: 'n-a1', bookId: 'b-a', content: 'First note', sortOrder: 0, owner: USER_A },
    { id: 'n-a2', bookId: 'b-a', content: 'Second note', sortOrder: 1, owner: USER_A },
    { id: 'n-b', bookId: 'b-b', content: 'Bob note', sortOrder: 0, owner: USER_B },
  );
}

beforeEach(seed);

describe('book-notes routes', () => {
  it('GET /book/:bookId returns the notes for that book to the owner and series collaborators', async () => {
    const asOwner = await request(app).get('/api/book-notes/book/b-a').set('x-test-user', USER_A);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.map((n: { id: string }) => n.id).sort()).toEqual(['n-a1', 'n-a2']);

    const asCollaborator = await request(app).get('/api/book-notes/book/b-a').set('x-test-user', COLLABORATOR);
    expect(asCollaborator.status).toBe(200);
    expect(asCollaborator.body.map((n: { id: string }) => n.id).sort()).toEqual(['n-a1', 'n-a2']);
  });

  it('POST / requires bookId and stamps ownership/audit fields', async () => {
    const missing = await request(app)
      .post('/api/book-notes')
      .set('x-test-user', USER_A)
      .send({ id: 'n-new', content: 'No book' });
    expect(missing.status).toBe(400);

    const res = await request(app)
      .post('/api/book-notes')
      .set('x-test-user', USER_A)
      .send({ id: 'n-new', bookId: 'b-a', content: 'Fresh', sortOrder: 2 });
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(USER_A);
    expect(res.body.createdBy).toBe(USER_A);
    expect(res.body.modifiedBy).toBe(USER_A);
    expect(res.body.createdAt).toBeTruthy();
  });

  it('PUT /:id lets the owner update content and stamps modifiedBy', async () => {
    const res = await request(app)
      .put('/api/book-notes/n-a1')
      .set('x-test-user', USER_A)
      .send({ content: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Updated');
    expect(res.body.modifiedBy).toBe(USER_A);
    expect(fake.container('book-notes').get('n-a1')!.content).toBe('Updated');
  });

  it('PUT /:id returns 404 for another user’s note and for unknown ids', async () => {
    const stranger = await request(app)
      .put('/api/book-notes/n-a1')
      .set('x-test-user', USER_B)
      .send({ content: 'Hijacked' });
    expect(stranger.status).toBe(404);
    expect(fake.container('book-notes').get('n-a1')!.content).toBe('First note');

    const missing = await request(app)
      .put('/api/book-notes/does-not-exist')
      .set('x-test-user', USER_A)
      .send({ content: 'x' });
    expect(missing.status).toBe(404);
  });

  it('PATCH /reorder updates sortOrder for the listed notes', async () => {
    const res = await request(app)
      .patch('/api/book-notes/reorder')
      .set('x-test-user', USER_A)
      .send([
        { id: 'n-a1', sortOrder: 1 },
        { id: 'n-a2', sortOrder: 0 },
      ]);
    expect(res.status).toBe(204);
    expect(fake.container('book-notes').get('n-a1')!.sortOrder).toBe(1);
    expect(fake.container('book-notes').get('n-a2')!.sortOrder).toBe(0);
  });

  it('DELETE /:id is owner-only', async () => {
    const stranger = await request(app).delete('/api/book-notes/n-a1').set('x-test-user', USER_B);
    expect(stranger.status).toBe(404);
    expect(fake.container('book-notes').get('n-a1')).toBeDefined();

    const owner = await request(app).delete('/api/book-notes/n-a1').set('x-test-user', USER_A);
    expect(owner.status).toBe(204);
    expect(fake.container('book-notes').get('n-a1')).toBeUndefined();
  });

  it('GET /book/:bookId denies users without access to the book, and unknown books', async () => {
    const stranger = await request(app).get('/api/book-notes/book/b-a').set('x-test-user', USER_B);
    expect(stranger.status).toBe(403);

    const unknown = await request(app).get('/api/book-notes/book/no-such-book').set('x-test-user', USER_A);
    expect(unknown.status).toBe(403);
  });

  it('PATCH /reorder ignores notes the caller does not own', async () => {
    const res = await request(app)
      .patch('/api/book-notes/reorder')
      .set('x-test-user', USER_B)
      .send([{ id: 'n-a1', sortOrder: 99 }]);
    expect(res.status).toBe(204);
    expect(fake.container('book-notes').get('n-a1')!.sortOrder).toBe(0);
  });
});
