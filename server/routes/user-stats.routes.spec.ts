import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import userStatsRoutes from './user-stats.routes';
import { makeTestApp, USER_A } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/user-stats', userStatsRoutes);

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY).toISOString();
const words = (n: number, word = 'w'): string => `<p>${Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')}</p>`;

let seq = 0;
const version = (chapterId: string, savedAt: string, content: string, extra: Record<string, unknown> = {}) => ({
  id: `v-${++seq}`, chapterId, savedAt, content, owner: USER_A, ...extra,
});

const getStats = () =>
  request(app).get('/api/user-stats/writing?days=30&tz=UTC').set('x-test-user', USER_A);

beforeEach(() => {
  fake.reset();
});

describe('GET /api/user-stats/writing', () => {
  it('diffs the first in-window version against the last version before the window, however old', async () => {
    fake.container('chapters').seed({ id: 'ch-old', title: 'Old', createdAt: daysAgo(400), owner: USER_A });
    fake.container('chapter-versions').seed(
      version('ch-old', daysAgo(200), words(5000)),
      version('ch-old', daysAgo(5), words(5010)),
    );

    const res = await getStats();
    expect(res.status).toBe(200);
    expect(res.body.summary.totalAdded).toBe(10);
    expect(res.body.summary.totalDeleted).toBe(0);
  });

  it('does not count a pre-existing chapter with no earlier version as all-new words', async () => {
    fake.container('chapters').seed({ id: 'ch-legacy', title: 'Legacy', createdAt: daysAgo(400), owner: USER_A });
    fake.container('chapter-versions').seed(
      version('ch-legacy', daysAgo(10), words(8000)),
      version('ch-legacy', daysAgo(9), words(8025)),
    );

    const res = await getStats();
    expect(res.body.summary.totalAdded).toBe(25);
    expect(res.body.daily).toHaveLength(1);
  });

  it('treats a chapter with no createdAt and no earlier version as pre-existing', async () => {
    fake.container('chapters').seed({ id: 'ch-untracked', title: 'Untracked', owner: USER_A });
    fake.container('chapter-versions').seed(version('ch-untracked', daysAgo(3), words(3000)));

    const res = await getStats();
    expect(res.body.summary.totalAdded).toBe(0);
    expect(res.body.byChapter).toEqual([]);
  });

  it('counts every word of a chapter created inside the window', async () => {
    fake.container('chapters').seed({ id: 'ch-new', title: 'New', createdAt: daysAgo(4), owner: USER_A });
    fake.container('chapter-versions').seed(version('ch-new', daysAgo(3), words(120)));

    const res = await getStats();
    expect(res.body.summary.totalAdded).toBe(120);
    expect(res.body.byChapter[0]).toMatchObject({ chapterId: 'ch-new', wordsAdded: 120 });
  });

  it('ignores fact-check reports stored in the versions container', async () => {
    fake.container('chapters').seed({ id: 'ch-a', title: 'A', createdAt: daysAgo(400), owner: USER_A });
    fake.container('chapter-versions').seed(
      version('ch-a', daysAgo(40), words(100)),
      version('ch-a', daysAgo(2), words(110)),
      version('ch-a', daysAgo(1), '', { docType: 'fact-check-report', findings: [] }),
    );

    const res = await getStats();
    expect(res.body.summary.totalAdded).toBe(10);
    expect(res.body.summary.totalDeleted).toBe(0);
  });
});
