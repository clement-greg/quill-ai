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

  it('PUT / replaces the full settings document (fields omitted on save are dropped)', async () => {
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
    expect(res.body.darkMode).toBeUndefined();
  });
});
