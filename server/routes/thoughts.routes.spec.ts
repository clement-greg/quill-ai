import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('../services/embeddings', () => ({
  generateEmbedding: jest.fn(async () => [0.1, 0.2, 0.3]),
}));

import thoughtsRoutes from './thoughts.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const generateEmbedding = jest.requireMock('../services/embeddings').generateEmbedding as jest.Mock;
const app = makeTestApp('/api/thoughts', thoughtsRoutes);

function seed(): void {
  fake.reset();
  fake.container('thought-items').seed(
    { id: 't-a1', title: 'Idea', content: 'Alpha thought', tags: [], owner: USER_A },
    { id: 't-a-deleted', content: 'Gone', tags: [], owner: USER_A, deleted: true },
    { id: 't-b', content: 'Bob thought', tags: [], owner: USER_B },
  );
}

beforeEach(() => {
  seed();
  generateEmbedding.mockClear();
  generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe('thoughts routes', () => {
  it('GET / returns only the caller’s non-deleted thoughts', async () => {
    const asA = await request(app).get('/api/thoughts').set('x-test-user', USER_A);
    expect(asA.status).toBe(200);
    expect(asA.body.map((t: { id: string }) => t.id)).toEqual(['t-a1']);

    const asB = await request(app).get('/api/thoughts').set('x-test-user', USER_B);
    expect(asB.body.map((t: { id: string }) => t.id)).toEqual(['t-b']);
  });

  it('POST / rejects blank content', async () => {
    const res = await request(app)
      .post('/api/thoughts')
      .set('x-test-user', USER_A)
      .send({ content: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST / creates a thought with an embedding vector and audit fields', async () => {
    const res = await request(app)
      .post('/api/thoughts')
      .set('x-test-user', USER_A)
      .send({ title: 'New', content: 'Something profound', tags: ['x'] });
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(USER_A);
    expect(res.body.contentVector).toEqual([0.1, 0.2, 0.3]);
    expect(generateEmbedding).toHaveBeenCalledWith('New\n\nSomething profound');
  });

  it('POST / still stores the thought when embedding generation fails', async () => {
    generateEmbedding.mockRejectedValueOnce(new Error('embedding down'));
    const res = await request(app)
      .post('/api/thoughts')
      .set('x-test-user', USER_A)
      .send({ content: 'No vector for me' });
    expect(res.status).toBe(201);
    expect(res.body.contentVector).toBeUndefined();
  });

  it('PUT /:id lets the owner update and refreshes the vector; strangers get 404', async () => {
    const owner = await request(app)
      .put('/api/thoughts/t-a1')
      .set('x-test-user', USER_A)
      .send({ content: 'Revised' });
    expect(owner.status).toBe(200);
    expect(owner.body.content).toBe('Revised');
    expect(owner.body.title).toBe('Idea'); // unspecified fields preserved
    expect(owner.body.contentVector).toEqual([0.1, 0.2, 0.3]);

    const stranger = await request(app)
      .put('/api/thoughts/t-a1')
      .set('x-test-user', USER_B)
      .send({ content: 'Hijacked' });
    expect(stranger.status).toBe(404);
    expect(fake.container('thought-items').get('t-a1')!.content).toBe('Revised');
  });

  it('DELETE /:id soft-deletes for the owner only, and restore undoes it', async () => {
    const stranger = await request(app).delete('/api/thoughts/t-a1').set('x-test-user', USER_B);
    expect(stranger.status).toBe(404);

    const owner = await request(app).delete('/api/thoughts/t-a1').set('x-test-user', USER_A);
    expect(owner.status).toBe(204);
    expect(fake.container('thought-items').get('t-a1')!.deleted).toBe(true);

    const list = await request(app).get('/api/thoughts').set('x-test-user', USER_A);
    expect(list.body).toEqual([]);

    const restored = await request(app).patch('/api/thoughts/t-a1/restore').set('x-test-user', USER_A);
    expect(restored.status).toBe(200);
    expect(restored.body.deleted).toBe(false);

    const listAfter = await request(app).get('/api/thoughts').set('x-test-user', USER_A);
    expect(listAfter.body.map((t: { id: string }) => t.id)).toEqual(['t-a1']);
  });

  it('PATCH /:id/restore returns 404 for unknown or foreign thoughts', async () => {
    expect((await request(app).patch('/api/thoughts/nope/restore').set('x-test-user', USER_A)).status).toBe(404);
    expect((await request(app).patch('/api/thoughts/t-b/restore').set('x-test-user', USER_A)).status).toBe(404);
  });
});
