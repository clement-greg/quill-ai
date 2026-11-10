import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import listeningRoutes from './listening.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/listening', listeningRoutes);

const position = (over: Record<string, unknown> = {}) => ({
  bookTitle: 'Book',
  chapterId: 'ch-1',
  chapterTitle: 'One',
  blockIndex: 3,
  progress: 0.25,
  ...over,
});

beforeEach(() => fake.reset());

describe('listening routes', () => {
  it('GET / is empty before anything is saved', async () => {
    const res = await request(app).get('/api/listening').set('x-test-user', USER_A);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('PUT /:bookId saves a position, stamped with the time', async () => {
    const res = await request(app).put('/api/listening/b1').set('x-test-user', USER_A).send(position());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bookId: 'b1', chapterId: 'ch-1', blockIndex: 3, progress: 0.25 });
    expect(typeof res.body.updatedAt).toBe('number');

    const list = await request(app).get('/api/listening').set('x-test-user', USER_A);
    expect(list.body.map((p: { bookId: string }) => p.bookId)).toEqual(['b1']);
  });

  it('keeps one position per book and lists the most recent first', async () => {
    await request(app).put('/api/listening/b1').set('x-test-user', USER_A).send(position());
    await new Promise(r => setTimeout(r, 2));
    await request(app).put('/api/listening/b2').set('x-test-user', USER_A).send(position({ chapterId: 'x' }));
    await new Promise(r => setTimeout(r, 2));
    await request(app).put('/api/listening/b1').set('x-test-user', USER_A).send(position({ blockIndex: 9 }));

    const list = await request(app).get('/api/listening').set('x-test-user', USER_A);
    expect(list.body.map((p: { bookId: string }) => p.bookId)).toEqual(['b1', 'b2']);
    expect(list.body[0].blockIndex).toBe(9);
  });

  it('keeps each user’s positions apart, and away from their settings document', async () => {
    await request(app).put('/api/listening/b1').set('x-test-user', USER_A).send(position());
    const other = await request(app).get('/api/listening').set('x-test-user', USER_B);
    expect(other.body).toEqual([]);
    expect(fake.container('user-settings').get(`sub-${USER_A}`)).toBeUndefined();
    expect(fake.container('user-settings').get(`listening::sub-${USER_A}`)).toBeDefined();
  });

  it('rejects malformed positions', async () => {
    for (const bad of [position({ chapterId: '' }), position({ blockIndex: -2 }), position({ progress: 'x' }), position({ blockIndex: 1.5 })]) {
      const res = await request(app).put('/api/listening/b1').set('x-test-user', USER_A).send(bad);
      expect(res.status).toBe(400);
    }
  });

  it('clamps progress to 0–1', async () => {
    const res = await request(app).put('/api/listening/b1').set('x-test-user', USER_A).send(position({ progress: 1.7 }));
    expect(res.body.progress).toBe(1);
  });
});
