import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import userSettingsRoutes from './user-settings.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/user-settings', userSettingsRoutes);

beforeEach(() => fake.reset());

describe('user-settings routes', () => {
  it('GET / returns an empty object when no settings are stored', async () => {
    const res = await request(app).get('/api/user-settings').set('x-test-user', USER_A);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('PUT / stores settings keyed to the caller and never exposes the id', async () => {
    const put = await request(app)
      .put('/api/user-settings')
      .set('x-test-user', USER_A)
      .send({ displayName: 'Alice', darkMode: true, colorTheme: 'violet' });
    expect(put.status).toBe(200);
    expect(put.body.id).toBeUndefined();
    expect(put.body.displayName).toBe('Alice');
    expect(put.body.email).toBe(USER_A);

    // Stored under the user's sub (test-app sets sub = `sub-${email}`)
    expect(fake.container('user-settings').get(`sub-${USER_A}`)).toBeDefined();

    const get = await request(app).get('/api/user-settings').set('x-test-user', USER_A);
    expect(get.body.id).toBeUndefined();
    expect(get.body.displayName).toBe('Alice');
    expect(get.body.darkMode).toBe(true);
  });

  it('settings are isolated per user', async () => {
    await request(app).put('/api/user-settings').set('x-test-user', USER_A).send({ displayName: 'Alice' });

    const asB = await request(app).get('/api/user-settings').set('x-test-user', USER_B);
    expect(asB.body).toEqual({});

    await request(app).put('/api/user-settings').set('x-test-user', USER_B).send({ displayName: 'Bob' });
    const asA = await request(app).get('/api/user-settings').set('x-test-user', USER_A);
    expect(asA.body.displayName).toBe('Alice');
  });

  it('PUT / merges into the stored document (fields omitted on save are kept)', async () => {
    await request(app)
      .put('/api/user-settings')
      .set('x-test-user', USER_A)
      .send({ displayName: 'Alice', darkMode: true });
    await request(app)
      .put('/api/user-settings')
      .set('x-test-user', USER_A)
      .send({ displayName: 'Alice Two' });

    const res = await request(app).get('/api/user-settings').set('x-test-user', USER_A);
    expect(res.body.displayName).toBe('Alice Two');
    expect(res.body.darkMode).toBe(true);
  });

  it('PUT / persists the grammar, entity-detection and auto-save toggles across reloads', async () => {
    const put = await request(app)
      .put('/api/user-settings')
      .set('x-test-user', USER_A)
      .send({ grammarCheckEnabled: false, entityDetectionEnabled: false, autoSaveEnabled: true });
    expect(put.status).toBe(200);

    const res = await request(app).get('/api/user-settings').set('x-test-user', USER_A);
    expect(res.body.grammarCheckEnabled).toBe(false);
    expect(res.body.entityDetectionEnabled).toBe(false);
    expect(res.body.autoSaveEnabled).toBe(true);
  });

  it('PUT / preserves pinHash when the client does not send it', async () => {
    fake.container('user-settings').seed({ id: `sub-${USER_A}`, email: USER_A, pinHash: 'hash-123' });

    // Mirrors the web client's saveToServer payload, which never includes pinHash
    await request(app)
      .put('/api/user-settings')
      .set('x-test-user', USER_A)
      .send({ displayName: 'Alice', colorTheme: 'dark', autoSaveEnabled: true });

    expect(fake.container('user-settings').get(`sub-${USER_A}`)?.pinHash).toBe('hash-123');
  });

  it.each([
    ['grammarCheckEnabled', 'false'],
    ['entityDetectionEnabled', 1],
    ['autoSaveEnabled', null],
    ['darkMode', 'yes'],
    ['displayName', 42],
    ['genderOptions', ['ok', 7]],
    ['ghostCompleteItems', [{ id: 'x', label: 'y' }]],
    ['aiModels', { chat: 'gpt-4' }],
    ['aiModels', { notAnOperation: 'luna' }],
    ['aiModels', ['luna']],
  ])('PUT / rejects an invalid %s with 400 and leaves stored settings untouched', async (field, value) => {
    await request(app).put('/api/user-settings').set('x-test-user', USER_A).send({ displayName: 'Alice' });

    const res = await request(app)
      .put('/api/user-settings')
      .set('x-test-user', USER_A)
      .send({ displayName: 'Changed', [field]: value });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);

    const get = await request(app).get('/api/user-settings').set('x-test-user', USER_A);
    expect(get.body.displayName).toBe('Alice');
  });

  it('PUT / ignores fields outside the whitelist', async () => {
    await request(app)
      .put('/api/user-settings')
      .set('x-test-user', USER_A)
      .send({ displayName: 'Alice', isAdmin: true, id: 'someone-else', email: 'spoof@example.com' });

    const stored = fake.container('user-settings').get(`sub-${USER_A}`);
    expect(stored?.isAdmin).toBeUndefined();
    expect(stored?.email).toBe(USER_A);
    expect(fake.container('user-settings').get('someone-else')).toBeUndefined();
  });

  it('PUT / stores a per-operation model pick', async () => {
    const res = await request(app)
      .put('/api/user-settings')
      .set('x-test-user', USER_A)
      .send({ aiModels: { chat: 'terra', editorReview: 'sol' } });
    expect(res.status).toBe(200);

    const get = await request(app).get('/api/user-settings').set('x-test-user', USER_A);
    expect(get.body.aiModels).toEqual({ chat: 'terra', editorReview: 'sol' });
  });
});
