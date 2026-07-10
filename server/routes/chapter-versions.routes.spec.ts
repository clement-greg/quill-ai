import request from 'supertest';

// uuid ships ESM-only builds that ts-jest does not transform; substitute a
// deterministic implementation for these tests.
jest.mock('uuid', () => {
  let n = 0;
  return { v4: () => `test-uuid-${++n}` };
});
jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import chapterVersionsRoutes from './chapter-versions.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/chapter-versions', chapterVersionsRoutes);

beforeEach(() => {
  fake.reset();
  fake.container('chapter-versions').seed(
    { id: 'v-a1', chapterId: 'ch-a', content: '<p>one</p>', savedAt: '2026-01-01T00:00:00Z', owner: USER_A },
    { id: 'v-a2', chapterId: 'ch-a', content: '<p>two</p>', savedAt: '2026-01-02T00:00:00Z', owner: USER_A },
    { id: 'v-other-chapter', chapterId: 'ch-x', content: '<p>x</p>', savedAt: '2026-01-03T00:00:00Z', owner: USER_A },
    { id: 'v-b', chapterId: 'ch-a', content: '<p>bob</p>', savedAt: '2026-01-04T00:00:00Z', owner: USER_B },
  );
});

describe('chapter-versions routes', () => {
  it('GET /chapter/:chapterId returns only the caller’s versions of that chapter', async () => {
    const asA = await request(app).get('/api/chapter-versions/chapter/ch-a').set('x-test-user', USER_A);
    expect(asA.status).toBe(200);
    expect(asA.body.map((v: { id: string }) => v.id).sort()).toEqual(['v-a1', 'v-a2']);

    const asB = await request(app).get('/api/chapter-versions/chapter/ch-a').set('x-test-user', USER_B);
    expect(asB.body.map((v: { id: string }) => v.id)).toEqual(['v-b']);
  });

  it('POST / validates chapterId and content', async () => {
    const noChapter = await request(app)
      .post('/api/chapter-versions')
      .set('x-test-user', USER_A)
      .send({ content: '<p>hi</p>' });
    expect(noChapter.status).toBe(400);

    const noContent = await request(app)
      .post('/api/chapter-versions')
      .set('x-test-user', USER_A)
      .send({ chapterId: 'ch-a' });
    expect(noContent.status).toBe(400);
  });

  it('POST / accepts empty-string content (only undefined is rejected)', async () => {
    const res = await request(app)
      .post('/api/chapter-versions')
      .set('x-test-user', USER_A)
      .send({ chapterId: 'ch-a', content: '' });
    expect(res.status).toBe(201);
    expect(res.body.content).toBe('');
  });

  it('POST / stamps owner, createdBy, and savedAt on the snapshot', async () => {
    const res = await request(app)
      .post('/api/chapter-versions')
      .set('x-test-user', USER_A)
      .send({ chapterId: 'ch-a', content: '<p>new</p>', createdByName: 'Alice' });
    expect(res.status).toBe(201);
    expect(res.body.owner).toBe(USER_A);
    expect(res.body.createdBy).toBe(USER_A);
    expect(res.body.createdByName).toBe('Alice');
    expect(res.body.savedAt).toBeTruthy();
    expect(fake.container('chapter-versions').get(res.body.id)).toBeDefined();
  });
});
