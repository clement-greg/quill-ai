import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import saRoutes from './sa.routes';
import backupsRoutes from './backups.routes';
import { makeTestApp } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';
import { BOOTSTRAP_SA_EMAILS, invalidateSaCache } from '../services/sa-access';

jest.mock('../services/storage', () => ({
  listBlobsWithPrefix: jest.fn(async () => []),
  deleteBlob: jest.fn(),
  downloadBlobStreamRaw: jest.fn(),
  uploadStreamToBlobRaw: jest.fn(),
}));

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/sa', saRoutes);
const backupsApp = makeTestApp('/api/backups', backupsRoutes);

const SA = BOOTSTRAP_SA_EMAILS[0];
const OTHER = 'someone@example.com';

beforeEach(() => {
  fake.reset();
  invalidateSaCache();
  fake.container('user-settings').seed(
    { id: 'u1', email: 'Someone@Example.com', displayName: 'Some One' },
    { id: 'u2', email: SA },
    { id: 'u3' },
  );
});

describe('SA access', () => {
  it('bootstraps the SA list on first read', async () => {
    const res = await request(app).get('/api/sa/me').set('x-test-user', SA);
    expect(res.body).toEqual({ isSa: true });
    expect(fake.container('app-settings').get('sa-users')?.['emails']).toEqual([SA]);
  });

  it('reports non-SA users, matching email case-insensitively', async () => {
    expect((await request(app).get('/api/sa/me').set('x-test-user', OTHER)).body).toEqual({ isSa: false });
    expect((await request(app).get('/api/sa/me').set('x-test-user', SA.toUpperCase())).body).toEqual({ isSa: true });
  });

  it('keeps user management and backups away from non-SA users', async () => {
    expect((await request(app).get('/api/sa/users').set('x-test-user', OTHER)).status).toBe(403);
    expect((await request(app).post('/api/sa/users').set('x-test-user', OTHER).send({ email: OTHER })).status).toBe(403);
    expect((await request(backupsApp).get('/api/backups').set('x-test-user', OTHER)).status).toBe(403);
    expect((await request(backupsApp).post('/api/backups/run').set('x-test-user', OTHER)).status).toBe(403);
    expect((await request(backupsApp).get('/api/backups/quill-backup-2026-11-12T15-44-20Z.zip/download').set('x-test-user', OTHER)).status).toBe(403);
  });

  it('lists SA users and signed-in users to pick from', async () => {
    const res = await request(app).get('/api/sa/users').set('x-test-user', SA);
    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual([SA]);
    expect(res.body.knownUsers).toEqual([
      { email: SA },
      { email: 'someone@example.com', displayName: 'Some One' },
    ].sort((a, b) => a.email.localeCompare(b.email)));
  });

  it('grants access, after which the new user is an SA', async () => {
    const res = await request(app).post('/api/sa/users').set('x-test-user', SA).send({ email: '  Someone@Example.com ' });
    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual([SA, OTHER].sort());
    expect((await request(app).get('/api/sa/me').set('x-test-user', OTHER)).body).toEqual({ isSa: true });
    expect(fake.container('app-settings').get('sa-users')?.['updatedBy']).toBe(SA);
  });

  it('rejects an invalid email', async () => {
    const res = await request(app).post('/api/sa/users').set('x-test-user', SA).send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('removes access, but never your own or the last SA', async () => {
    await request(app).post('/api/sa/users').set('x-test-user', SA).send({ email: OTHER });

    const self = await request(app).delete(`/api/sa/users/${encodeURIComponent(SA)}`).set('x-test-user', SA);
    expect(self.status).toBe(400);

    const res = await request(app).delete(`/api/sa/users/${encodeURIComponent(OTHER)}`).set('x-test-user', SA);
    expect(res.status).toBe(200);
    expect(res.body.emails).toEqual([SA]);
    expect((await request(app).get('/api/sa/me').set('x-test-user', OTHER)).body).toEqual({ isSa: false });
  });

  it('rejects backup names that are not backups', async () => {
    const res = await request(backupsApp).get('/api/backups/..%2Fphotos%2Fx.zip/download').set('x-test-user', SA);
    expect(res.status).toBe(400);
    const missing = await request(backupsApp).delete('/api/backups/quill-backup-2026-11-12T15-44-20Z.zip').set('x-test-user', SA);
    expect(missing.status).toBe(404);
  });
});
