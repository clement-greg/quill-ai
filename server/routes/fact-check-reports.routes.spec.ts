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

import factCheckReportRoutes from './fact-check-reports.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos, FakeDoc } from '../testing/fake-cosmos';
import { FactCheckReport, SavedFactCheckFinding } from '../../shared/models/fact-check.model';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/fact-check-reports', factCheckReportRoutes);

function finding(overrides: Partial<SavedFactCheckFinding> = {}): SavedFactCheckFinding {
  return {
    id: 'f-1',
    claim: 'The Titanic sank in 1912.',
    category: 'history',
    verdict: 'verified',
    confidence: 90,
    explanation: 'It did.',
    grounded: false,
    ...overrides,
  };
}

/** Seeded documents go through the fake container's loose doc type, so the
 * return is widened rather than typed as FactCheckReport. */
function report(overrides: Partial<FactCheckReport> = {}): FakeDoc {
  return {
    id: 'r-1',
    docType: 'fact-check-report',
    chapterId: 'ch-a',
    runAt: '2026-01-01T00:00:00Z',
    findings: [finding()],
    total: 1,
    truncated: false,
    stopped: false,
    searchAvailable: true,
    owner: USER_A,
    ...overrides,
  };
}

beforeEach(() => {
  fake.reset();
  // Reports share the chapter-versions container; see cosmos.ts.
  fake.container('chapter-versions').seed(
    report({ id: 'r-old', runAt: '2026-01-01T00:00:00Z' }),
    report({ id: 'r-new', runAt: '2026-02-01T00:00:00Z' }),
    report({ id: 'r-other-chapter', chapterId: 'ch-x' }),
    report({ id: 'r-bob', owner: USER_B }),
    // A version snapshot shares this container and this chapter's partition.
    { id: 'v-a1', chapterId: 'ch-a', docType: 'version', content: '<p>one</p>', savedAt: '2026-01-01T00:00:00Z', owner: USER_A },
  );
});

describe('fact-check-reports routes', () => {
  it('GET /chapter/:chapterId returns only the caller’s reports, newest run first', async () => {
    const res = await request(app)
      .get('/api/fact-check-reports/chapter/ch-a')
      .set('x-test-user', USER_A);

    expect(res.status).toBe(200);
    expect(res.body.map((r: FactCheckReport) => r.id)).toEqual(['r-new', 'r-old']);
  });

  it('GET /chapter/:chapterId does not leak another author’s reports', async () => {
    const res = await request(app)
      .get('/api/fact-check-reports/chapter/ch-a')
      .set('x-test-user', USER_B);

    expect(res.body.map((r: FactCheckReport) => r.id)).toEqual(['r-bob']);
  });

  it('leaves version snapshots out of the report list', async () => {
    const res = await request(app)
      .get('/api/fact-check-reports/chapter/ch-a')
      .set('x-test-user', USER_A);
    expect(res.body.map((r: FactCheckReport) => r.id)).toEqual(['r-new', 'r-old']);
  });

  it('will not triage or delete a version snapshot as though it were a report', async () => {
    const patched = await request(app)
      .patch('/api/fact-check-reports/v-a1/findings/f-1')
      .set('x-test-user', USER_A)
      .send({ chapterId: 'ch-a', resolved: true });
    expect(patched.status).toBe(404);

    const deleted = await request(app)
      .delete('/api/fact-check-reports/v-a1?chapterId=ch-a')
      .set('x-test-user', USER_A);
    expect(deleted.status).toBe(404);
  });

  describe('POST /', () => {
    it('saves a run, stamping ownership and clearing check-off state', async () => {
      const res = await request(app)
        .post('/api/fact-check-reports')
        .set('x-test-user', USER_A)
        .send({
          chapterId: 'ch-a',
          chapterTitle: 'The Forester',
          runAt: '2026-03-01T00:00:00Z',
          // A client claiming a finding is already dealt with must not be
          // believed — triage happens through PATCH, never at save time.
          findings: [finding({ id: 'f-9', resolved: true, resolvedAt: '2020-01-01T00:00:00Z' })],
          total: 3,
          truncated: true,
          stopped: true,
          searchAvailable: true,
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        chapterId: 'ch-a',
        chapterTitle: 'The Forester',
        total: 3,
        truncated: true,
        stopped: true,
        owner: USER_A,
        createdBy: USER_A,
      });
      expect(res.body.findings[0].resolved).toBe(false);
      expect(res.body.findings[0].resolvedAt).toBeUndefined();
    });

    it('adds a new report rather than replacing the chapter’s earlier ones', async () => {
      await request(app)
        .post('/api/fact-check-reports')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-a', findings: [finding()] });

      const list = await request(app)
        .get('/api/fact-check-reports/chapter/ch-a')
        .set('x-test-user', USER_A);
      expect(list.body).toHaveLength(3);
    });

    it('falls back to the reported findings count when total is not credible', async () => {
      const res = await request(app)
        .post('/api/fact-check-reports')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-a', findings: [finding(), finding({ id: 'f-2' })], total: 1 });

      expect(res.body.total).toBe(2);
    });

    it('rejects a report with no chapter or no usable findings', async () => {
      const noChapter = await request(app)
        .post('/api/fact-check-reports')
        .set('x-test-user', USER_A)
        .send({ findings: [finding()] });
      expect(noChapter.status).toBe(400);

      const noFindings = await request(app)
        .post('/api/fact-check-reports')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-a', findings: [{ claim: 'missing a verdict' }] });
      expect(noFindings.status).toBe(400);
    });
  });

  describe('PATCH /:id/findings/:findingId', () => {
    it('checks a finding off and dates it', async () => {
      const res = await request(app)
        .patch('/api/fact-check-reports/r-new/findings/f-1')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-a', resolved: true });

      expect(res.status).toBe(200);
      expect(res.body.findings[0].resolved).toBe(true);
      expect(res.body.findings[0].resolvedAt).toBeTruthy();
      expect(res.body.modifiedBy).toBe(USER_A);
    });

    it('drops the date when a finding is put back on the list', async () => {
      await request(app)
        .patch('/api/fact-check-reports/r-new/findings/f-1')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-a', resolved: true });

      const res = await request(app)
        .patch('/api/fact-check-reports/r-new/findings/f-1')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-a', resolved: false });

      expect(res.body.findings[0].resolved).toBe(false);
      expect(res.body.findings[0].resolvedAt).toBeUndefined();
    });

    it('validates chapterId and the resolved flag', async () => {
      const noChapter = await request(app)
        .patch('/api/fact-check-reports/r-new/findings/f-1')
        .set('x-test-user', USER_A)
        .send({ resolved: true });
      expect(noChapter.status).toBe(400);

      const badFlag = await request(app)
        .patch('/api/fact-check-reports/r-new/findings/f-1')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-a', resolved: 'yes' });
      expect(badFlag.status).toBe(400);
    });

    it('404s on an unknown finding and on another author’s report', async () => {
      const unknownFinding = await request(app)
        .patch('/api/fact-check-reports/r-new/findings/nope')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-a', resolved: true });
      expect(unknownFinding.status).toBe(404);

      const othersReport = await request(app)
        .patch('/api/fact-check-reports/r-new/findings/f-1')
        .set('x-test-user', USER_B)
        .send({ chapterId: 'ch-a', resolved: true });
      expect(othersReport.status).toBe(404);
    });
  });

  describe('DELETE /:id', () => {
    it('deletes the caller’s own report', async () => {
      const res = await request(app)
        .delete('/api/fact-check-reports/r-old?chapterId=ch-a')
        .set('x-test-user', USER_A);
      expect(res.status).toBe(204);

      const list = await request(app)
        .get('/api/fact-check-reports/chapter/ch-a')
        .set('x-test-user', USER_A);
      expect(list.body.map((r: FactCheckReport) => r.id)).toEqual(['r-new']);
    });

    it('will not delete another author’s report', async () => {
      const res = await request(app)
        .delete('/api/fact-check-reports/r-new?chapterId=ch-a')
        .set('x-test-user', USER_B);
      expect(res.status).toBe(404);
    });

    it('requires the chapterId partition key', async () => {
      const res = await request(app)
        .delete('/api/fact-check-reports/r-new')
        .set('x-test-user', USER_A);
      expect(res.status).toBe(400);
    });
  });
});
