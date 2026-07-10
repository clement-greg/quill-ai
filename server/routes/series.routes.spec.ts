import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('openai', () => ({
  AzureOpenAI: jest.fn(() => ({ chat: { completions: { create: jest.fn() } } })),
}));

import seriesRoutes from './series.routes';
import { makeTestApp, USER_A, USER_B, COLLABORATOR } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/series', seriesRoutes);

function seed(): void {
  fake.reset();
  fake.container('series').seed(
    { id: 's-a', title: 'Alpha', owner: USER_A, collaborators: [COLLABORATOR] },
    { id: 's-a-archived', title: 'Alpha Old', owner: USER_A, archived: true },
    { id: 's-b', title: 'Beta', owner: USER_B },
  );
}

beforeEach(seed);

describe('series routes — owner and collaborator access', () => {
  it('GET / returns owned series plus series shared with the user', async () => {
    const asOwner = await request(app).get('/api/series').set('x-test-user', USER_A);
    expect(asOwner.body.map((s: { id: string }) => s.id)).toEqual(['s-a']);

    const asCollaborator = await request(app).get('/api/series').set('x-test-user', COLLABORATOR);
    expect(asCollaborator.body.map((s: { id: string }) => s.id)).toEqual(['s-a']);

    const asStranger = await request(app).get('/api/series').set('x-test-user', 'nobody@example.com');
    expect(asStranger.body).toEqual([]);
  });

  it('GET /archived returns owned archives only — not shared ones', async () => {
    const asOwner = await request(app).get('/api/series/archived').set('x-test-user', USER_A);
    expect(asOwner.body.map((s: { id: string }) => s.id)).toEqual(['s-a-archived']);

    const asCollaborator = await request(app).get('/api/series/archived').set('x-test-user', COLLABORATOR);
    expect(asCollaborator.body).toEqual([]);
  });

  it('GET /:id serves the owner and collaborators, hides it from others', async () => {
    expect((await request(app).get('/api/series/s-a').set('x-test-user', USER_A)).status).toBe(200);
    expect((await request(app).get('/api/series/s-a').set('x-test-user', COLLABORATOR)).status).toBe(200);
    expect((await request(app).get('/api/series/s-a').set('x-test-user', USER_B)).status).toBe(404);
  });

  it('PATCH /:id/archive is owner-only — collaborators get a 404', async () => {
    const asCollaborator = await request(app).patch('/api/series/s-a/archive').set('x-test-user', COLLABORATOR);
    expect(asCollaborator.status).toBe(404);
    expect(fake.container('series').get('s-a')!.archived).toBeUndefined();

    const asOwner = await request(app).patch('/api/series/s-a/archive').set('x-test-user', USER_A);
    expect(asOwner.status).toBe(200);
    expect(fake.container('series').get('s-a')!.archived).toBe(true);
  });

  it('POST / stamps the requesting user as owner', async () => {
    const res = await request(app)
      .post('/api/series')
      .set('x-test-user', USER_A)
      .send({ id: 's-new', title: 'New Series' });
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(USER_A);
  });

  describe('collaborator management', () => {
    it('lets the owner add a collaborator, without duplicates', async () => {
      const first = await request(app)
        .post('/api/series/s-a/collaborators')
        .set('x-test-user', USER_A)
        .send({ email: 'dave@example.com' });
      expect(first.status).toBe(200);
      expect(first.body.collaborators).toEqual([COLLABORATOR, 'dave@example.com']);

      const again = await request(app)
        .post('/api/series/s-a/collaborators')
        .set('x-test-user', USER_A)
        .send({ email: 'dave@example.com' });
      expect(again.body.collaborators).toEqual([COLLABORATOR, 'dave@example.com']);
    });

    it('rejects collaborator changes from non-owners (even collaborators)', async () => {
      const res = await request(app)
        .post('/api/series/s-a/collaborators')
        .set('x-test-user', COLLABORATOR)
        .send({ email: 'dave@example.com' });
      expect(res.status).toBe(404);
    });

    it('rejects invalid emails and the owner’s own address', async () => {
      const invalid = await request(app)
        .post('/api/series/s-a/collaborators')
        .set('x-test-user', USER_A)
        .send({ email: 'not-an-email' });
      expect(invalid.status).toBe(400);

      const self = await request(app)
        .post('/api/series/s-a/collaborators')
        .set('x-test-user', USER_A)
        .send({ email: USER_A });
      expect(self.status).toBe(400);
    });

    it('lets the owner remove a collaborator', async () => {
      const res = await request(app)
        .delete(`/api/series/s-a/collaborators/${encodeURIComponent(COLLABORATOR)}`)
        .set('x-test-user', USER_A);
      expect(res.status).toBe(200);
      expect(res.body.collaborators).toEqual([]);
    });
  });

  // Documents a known gap: these endpoints do no ownership check today.
  // When the guard is added, these start failing — remove `.failing` then.
  it.failing('PUT /:id rejects updates to another user’s series', async () => {
    const res = await request(app)
      .put('/api/series/s-b')
      .set('x-test-user', USER_A)
      .send({ title: 'Hijacked' });
    expect([403, 404]).toContain(res.status);
  });

  it.failing('DELETE /:id rejects deleting another user’s series', async () => {
    const res = await request(app).delete('/api/series/s-b').set('x-test-user', USER_A);
    expect([403, 404]).toContain(res.status);
  });
});
