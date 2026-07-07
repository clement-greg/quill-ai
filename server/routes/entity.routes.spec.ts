import request from 'supertest';

jest.mock('../cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('openai', () => ({
  AzureOpenAI: jest.fn(() => ({ chat: { completions: { create: jest.fn() } } })),
}));
jest.mock('../storage', () => ({ deleteBlob: jest.fn() }));
jest.mock('../chapter-chunks', () => ({ searchChapterChunks: jest.fn() }));
jest.mock('../timeline-event-chunks', () => ({ deleteTimelineEventChunksForEntity: jest.fn() }));

import entityRoutes from './entity.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/entities', entityRoutes);

function seed(): void {
  fake.reset();
  fake.container('entities').seed(
    {
      id: 'e-a',
      name: 'Arthur',
      type: 'PERSON',
      seriesId: 's-a',
      owner: USER_A,
      photos: [{ url: 'https://blob/x.png', thumbnailUrl: 'https://blob/x-thumb.png' }],
    },
    { id: 'e-a-archived', name: 'Old Arthur', type: 'PERSON', seriesId: 's-a', owner: USER_A, archived: true },
    { id: 'e-narrator', name: 'Narrator', type: 'PERSON', seriesId: 's-a', owner: USER_A, isNarrator: true },
    { id: 'e-b', name: 'Bobette', type: 'PERSON', seriesId: 's-b', owner: USER_B },
  );
}

beforeEach(seed);

describe('entity routes — owner guard', () => {
  it('GET / returns only the requesting user’s active entities', async () => {
    const res = await request(app).get('/api/entities').set('x-test-user', USER_A);
    expect(res.status).toBe(200);
    expect(res.body.map((e: { id: string }) => e.id).sort()).toEqual(['e-a', 'e-narrator']);
  });

  it('GET /archived returns only the requesting user’s archived entities', async () => {
    const res = await request(app).get('/api/entities/archived').set('x-test-user', USER_A);
    expect(res.body.map((e: { id: string }) => e.id)).toEqual(['e-a-archived']);
  });

  it('GET /:id hides another user’s entity behind a 404', async () => {
    expect((await request(app).get('/api/entities/e-a').set('x-test-user', USER_A)).status).toBe(200);
    expect((await request(app).get('/api/entities/e-b').set('x-test-user', USER_A)).status).toBe(404);
  });

  it('POST / validates the type and stamps the owner', async () => {
    const invalid = await request(app)
      .post('/api/entities')
      .set('x-test-user', USER_A)
      .send({ id: 'e-x', name: 'X', seriesId: 's-a', type: 'DRAGON' });
    expect(invalid.status).toBe(400);

    const created = await request(app)
      .post('/api/entities')
      .set('x-test-user', USER_A)
      .send({ id: 'e-new', name: 'New', seriesId: 's-a', type: 'PLACE' });
    expect(created.status).toBe(201);
    expect(created.body.owner).toBe(USER_A);
  });

  describe('PUT /:id', () => {
    it('rejects updates to another user’s entity', async () => {
      const res = await request(app)
        .put('/api/entities/e-b')
        .set('x-test-user', USER_A)
        .send({ name: 'Hijacked', type: 'PERSON', seriesId: 's-b' });
      expect(res.status).toBe(404);
      expect(fake.container('entities').get('e-b')!.name).toBe('Bobette');
    });

    it('preserves the stored owner and photos regardless of the request body', async () => {
      const res = await request(app)
        .put('/api/entities/e-a')
        .set('x-test-user', USER_A)
        .send({ name: 'Arthur II', type: 'PERSON', seriesId: 's-a', owner: USER_B, photos: [] });
      expect(res.status).toBe(200);
      expect(res.body.owner).toBe(USER_A);
      expect(res.body.photos).toHaveLength(1);
      expect(res.body.name).toBe('Arthur II');
    });

    it('keeps the narrator’s name immutable', async () => {
      const res = await request(app)
        .put('/api/entities/e-narrator')
        .set('x-test-user', USER_A)
        .send({ name: 'Not The Narrator', type: 'PERSON', seriesId: 's-a', personality: 'wry' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Narrator');
      expect(res.body.isNarrator).toBe(true);
      expect(res.body.personality).toBe('wry');
    });
  });

  it('PATCH /reorder silently skips entities the user does not own', async () => {
    const res = await request(app)
      .patch('/api/entities/reorder')
      .set('x-test-user', USER_A)
      .send({ ids: ['e-b', 'e-a'] });
    expect(res.status).toBe(204);
    expect(fake.container('entities').get('e-a')!.sortOrder).toBe(1);
    expect(fake.container('entities').get('e-b')!.sortOrder).toBeUndefined();
  });

  it('PATCH /:id/archive rejects a non-owner with 404', async () => {
    const res = await request(app).patch('/api/entities/e-b/archive').set('x-test-user', USER_A);
    expect(res.status).toBe(404);
    expect(fake.container('entities').get('e-b')!.archived).toBeUndefined();
  });

  // Documents a known gap: hard delete does no ownership check today.
  // When the guard is added, this starts failing — remove `.failing` then.
  it.failing('DELETE /:id rejects deleting another user’s entity', async () => {
    const res = await request(app).delete('/api/entities/e-b').set('x-test-user', USER_A);
    expect([403, 404]).toContain(res.status);
  });
});
