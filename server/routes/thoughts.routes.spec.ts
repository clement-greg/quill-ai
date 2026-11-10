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

const ids = (page: { items: { id: string }[] }) => page.items.map((t) => t.id);

beforeEach(() => {
  seed();
  generateEmbedding.mockClear();
  generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe('thoughts routes', () => {
  it('GET / returns only the caller’s non-deleted thoughts', async () => {
    const asA = await request(app).get('/api/thoughts').set('x-test-user', USER_A);
    expect(asA.status).toBe(200);
    expect(ids(asA.body)).toEqual(['t-a1']);
    expect(asA.body.total).toBe(1);

    const asB = await request(app).get('/api/thoughts').set('x-test-user', USER_B);
    expect(ids(asB.body)).toEqual(['t-b']);
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
    expect(list.body.items).toEqual([]);

    const restored = await request(app).patch('/api/thoughts/t-a1/restore').set('x-test-user', USER_A);
    expect(restored.status).toBe(200);
    expect(restored.body.deleted).toBe(false);

    const listAfter = await request(app).get('/api/thoughts').set('x-test-user', USER_A);
    expect(ids(listAfter.body)).toEqual(['t-a1']);
  });

  it('GET /:id hides deleted thoughts', async () => {
    expect((await request(app).get('/api/thoughts/t-a-deleted').set('x-test-user', USER_A)).status).toBe(404);
  });

  it('PATCH /:id/restore returns 404 for unknown or foreign thoughts', async () => {
    expect((await request(app).patch('/api/thoughts/nope/restore').set('x-test-user', USER_A)).status).toBe(404);
    expect((await request(app).patch('/api/thoughts/t-b/restore').set('x-test-user', USER_A)).status).toBe(404);
  });

  describe('tags and paging', () => {
    beforeEach(() => {
      fake.reset();
      fake.container('thought-items').seed(
        { id: 'n1', content: 'one', tags: ['Plot', 'Quirk'], owner: USER_A, modifiedAt: '2026-01-01', contentVector: [1] },
        { id: 'n2', content: 'two', tags: ['quirk'], owner: USER_A, modifiedAt: '2026-01-02' },
        { id: 'n3', content: 'three', tags: [], owner: USER_A, modifiedAt: '2026-01-03' },
        { id: 'n4', content: 'four', owner: USER_A, modifiedAt: '2026-01-04' },
        { id: 'nb', content: 'bob', tags: ['secret'], owner: USER_B, modifiedAt: '2026-01-05' },
      );
    });

    it('lists the caller’s tags with counts, merging case variants, and omits vectors', async () => {
      const res = await request(app).get('/api/thoughts').set('x-test-user', USER_A);
      expect(res.body.tags).toEqual([
        { tag: 'Plot', count: 1 },
        { tag: 'quirk', count: 2 }, // spelling from the most recent thought
      ]);
      expect(res.body.items.every((t: { contentVector?: unknown }) => t.contentVector === undefined)).toBe(true);
    });

    it('filters to thoughts carrying every requested tag, case-insensitively', async () => {
      const one = await request(app).get('/api/thoughts?tags=QUIRK').set('x-test-user', USER_A);
      expect(ids(one.body)).toEqual(['n2', 'n1']);
      expect(one.body.total).toBe(2);
      expect(one.body.tags).toHaveLength(2); // tag list ignores the filter

      const both = await request(app).get('/api/thoughts?tags=quirk,plot').set('x-test-user', USER_A);
      expect(ids(both.body)).toEqual(['n1']);
    });

    it('pages with offset and limit, reporting the full total', async () => {
      const res = await request(app).get('/api/thoughts?offset=1&limit=2').set('x-test-user', USER_A);
      expect(ids(res.body)).toEqual(['n3', 'n2']);
      expect(res.body.total).toBe(4);
    });

    it('defaults to 50 per page and caps the limit at 500', async () => {
      const many = Array.from({ length: 520 }, (_, i) => ({
        id: `m${i}`, content: `m${i}`, owner: USER_A, modifiedAt: `2025-${String(i).padStart(4, '0')}`,
      }));
      fake.container('thought-items').seed(...many);
      const dflt = await request(app).get('/api/thoughts').set('x-test-user', USER_A);
      expect(dflt.body.items).toHaveLength(50);
      const capped = await request(app).get('/api/thoughts?limit=9999').set('x-test-user', USER_A);
      expect(capped.body.items).toHaveLength(500);
      expect(capped.body.total).toBe(524);
    });

    it('filters by search words across title, content and tags, combined with tags', async () => {
      const q = await request(app).get('/api/thoughts?q=TWO').set('x-test-user', USER_A);
      expect(ids(q.body)).toEqual(['n2']);
      expect(q.body.total).toBe(1);

      const byTagWord = await request(app).get('/api/thoughts?q=plot').set('x-test-user', USER_A);
      expect(ids(byTagWord.body)).toEqual(['n1']);

      const both = await request(app).get('/api/thoughts?q=o&tags=quirk').set('x-test-user', USER_A);
      expect(ids(both.body)).toEqual(['n2', 'n1']); // 1-char query ignored, tag filter kept

      const none = await request(app).get('/api/thoughts?q=one%20two').set('x-test-user', USER_A);
      expect(none.body.total).toBe(0); // every word must match
    });

    it('GET /:id returns the owner’s thought without its vector; 404 otherwise', async () => {
      const own = await request(app).get('/api/thoughts/n1').set('x-test-user', USER_A);
      expect(own.status).toBe(200);
      expect(own.body.content).toBe('one');
      expect(own.body.contentVector).toBeUndefined();

      expect((await request(app).get('/api/thoughts/nb').set('x-test-user', USER_A)).status).toBe(404);
      expect((await request(app).get('/api/thoughts/missing').set('x-test-user', USER_A)).status).toBe(404);
    });

    it('normalizes tags on create and update', async () => {
      const created = await request(app)
        .post('/api/thoughts')
        .set('x-test-user', USER_A)
        .send({ content: 'x', tags: ['  Big   idea ', 'big idea', '', 'a,b', 7] });
      expect(created.body.tags).toEqual(['Big idea', 'a b']);

      const updated = await request(app)
        .put('/api/thoughts/n2')
        .set('x-test-user', USER_A)
        .send({ tags: ['Villain'] });
      expect(updated.body.tags).toEqual(['Villain']);
      expect(updated.body.content).toBe('two');
    });

    it('does not re-embed when only the tags change', async () => {
      await request(app).put('/api/thoughts/n1').set('x-test-user', USER_A).send({ tags: ['New'] });
      expect(generateEmbedding).not.toHaveBeenCalled();
      expect(fake.container('thought-items').get('n1')!.contentVector).toEqual([1]);
    });
  });
});

describe('thoughts and tasks share a container', () => {
  beforeEach(() => {
    fake.container('thought-items').seed(
      { id: 'task-1', docType: 'task', title: 'A task', bookId: 'b', completed: false, owner: USER_A },
      { id: 't-new', docType: 'thought', content: 'Stamped thought', owner: USER_A },
    );
  });

  it('never lists a task as a thought', async () => {
    const res = await request(app).get('/api/thoughts').set('x-test-user', USER_A);
    expect(ids(res.body).sort()).toEqual(['t-a1', 't-new']);
  });

  it('will not read, edit, or delete a task through the thoughts API', async () => {
    expect((await request(app).get('/api/thoughts/task-1').set('x-test-user', USER_A)).status).toBe(404);
    expect((await request(app).put('/api/thoughts/task-1').set('x-test-user', USER_A).send({ content: 'x' })).status).toBe(404);
    expect((await request(app).delete('/api/thoughts/task-1').set('x-test-user', USER_A)).status).toBe(404);
    expect(fake.container('thought-items').get('task-1')?.['deleted']).toBeUndefined();
  });

  it('stamps new thoughts with their docType', async () => {
    const res = await request(app).post('/api/thoughts').set('x-test-user', USER_A).send({ content: 'Fresh' });
    expect(res.body.docType).toBe('thought');
  });
});
