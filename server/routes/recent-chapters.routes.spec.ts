import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import recentChaptersRoutes from './recent-chapters.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/recent-chapters', recentChaptersRoutes);

const SUB_A = `sub-${USER_A}`;
const SUB_B = `sub-${USER_B}`;

beforeEach(() => {
  fake.reset();
  // Seeded newest-first: the fake preserves insertion order (it does not apply
  // ORDER BY), and the route expects visits sorted by visitedAt DESC.
  fake.container('chapter-visits').seed(
    { id: 'v3', userSub: SUB_A, chapterId: 'ch-1', chapterTitle: 'One (revisit)', bookTitle: 'B', seriesTitle: 'S', visitedAt: 3000 },
    { id: 'v2', userSub: SUB_A, chapterId: 'ch-2', chapterTitle: 'Two', bookTitle: 'B', seriesTitle: 'S', visitedAt: 2000 },
    { id: 'v1', userSub: SUB_A, chapterId: 'ch-1', chapterTitle: 'One', bookTitle: 'B', seriesTitle: 'S', visitedAt: 1000 },
    { id: 'vb', userSub: SUB_B, chapterId: 'ch-b', chapterTitle: 'Bobs', bookTitle: 'B', seriesTitle: 'S', visitedAt: 5000 },
  );
});

describe('recent-chapters routes', () => {
  it('GET / collapses repeat visits to distinct chapters, keeping the newest', async () => {
    const res = await request(app).get('/api/recent-chapters').set('x-test-user', USER_A);
    expect(res.status).toBe(200);
    expect(res.body.map((r: { chapterId: string }) => r.chapterId)).toEqual(['ch-1', 'ch-2']);
    expect(res.body[0].chapterTitle).toBe('One (revisit)');
    expect(res.body[0].visitedAt).toBe(3000);
  });

  it('GET / only returns the caller’s own visits', async () => {
    const res = await request(app).get('/api/recent-chapters').set('x-test-user', USER_B);
    expect(res.body.map((r: { chapterId: string }) => r.chapterId)).toEqual(['ch-b']);
  });

  it('POST / requires chapterId', async () => {
    const res = await request(app).post('/api/recent-chapters').set('x-test-user', USER_A).send({});
    expect(res.status).toBe(400);
  });

  it('POST / records an immutable visit stamped with the caller’s sub and defaults', async () => {
    const res = await request(app)
      .post('/api/recent-chapters')
      .set('x-test-user', USER_A)
      .send({ chapterId: 'ch-9' });
    expect(res.status).toBe(201);
    expect(res.body.userSub).toBe(SUB_A);
    expect(res.body.chapterId).toBe('ch-9');
    expect(res.body.chapterTitle).toBe('Chapter');
    expect(res.body.bookTitle).toBe('');
    expect(typeof res.body.visitedAt).toBe('number');
    expect(fake.container('chapter-visits').get(res.body.id)).toBeDefined();
  });

  it('POST / ignores a client-supplied userSub (cannot spoof another user)', async () => {
    const res = await request(app)
      .post('/api/recent-chapters')
      .set('x-test-user', USER_A)
      .send({ chapterId: 'ch-9', userSub: SUB_B });
    expect(res.body.userSub).toBe(SUB_A);
  });
});
