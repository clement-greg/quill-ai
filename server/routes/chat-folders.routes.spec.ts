import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import chatFoldersRoutes from './chat-folders.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/chat-folders', chatFoldersRoutes);

function seed(): void {
  fake.reset();
  fake.container('chat-folders').seed(
    { id: 'f-root', name: 'Root', owner: USER_A, parentFolderId: null, seriesId: null },
    { id: 'f-child', name: 'Child', owner: USER_A, parentFolderId: 'f-root', seriesId: null },
    { id: 'f-b', name: 'Bobs', owner: USER_B, parentFolderId: null, seriesId: null },
  );
  fake.container('chat-sessions').seed(
    { id: 'sess-1', owner: USER_A, folderId: 'f-root' },
    { id: 'sess-deleted', owner: USER_A, folderId: 'f-root', deleted: true },
    { id: 'sess-b', owner: USER_B, folderId: 'f-root' },
  );
}

beforeEach(seed);

describe('chat-folders routes', () => {
  it('GET / lists only the caller’s folders', async () => {
    const asA = await request(app).get('/api/chat-folders').set('x-test-user', USER_A);
    expect(asA.status).toBe(200);
    expect(asA.body.map((f: { id: string }) => f.id).sort()).toEqual(['f-child', 'f-root']);

    const asB = await request(app).get('/api/chat-folders').set('x-test-user', USER_B);
    expect(asB.body.map((f: { id: string }) => f.id)).toEqual(['f-b']);
  });

  it('POST / requires a name and stamps the owner, trimming the name', async () => {
    const missing = await request(app).post('/api/chat-folders').set('x-test-user', USER_A).send({ name: '  ' });
    expect(missing.status).toBe(400);

    const res = await request(app)
      .post('/api/chat-folders')
      .set('x-test-user', USER_A)
      .send({ name: '  New Folder  ' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Folder');
    expect(res.body.owner).toBe(USER_A);
    expect(res.body.parentFolderId).toBeNull();
    expect(fake.container('chat-folders').get(res.body.id)).toBeDefined();
  });

  it('PUT /:id renames and re-parents for the owner; strangers get 404', async () => {
    const stranger = await request(app)
      .put('/api/chat-folders/f-root')
      .set('x-test-user', USER_B)
      .send({ name: 'Hijacked' });
    expect(stranger.status).toBe(404);
    expect(fake.container('chat-folders').get('f-root')!.name).toBe('Root');

    const owner = await request(app)
      .put('/api/chat-folders/f-child')
      .set('x-test-user', USER_A)
      .send({ name: '  Renamed ', parentFolderId: null });
    expect(owner.status).toBe(200);
    const doc = fake.container('chat-folders').get('f-child')!;
    expect(doc.name).toBe('Renamed');
    expect(doc.parentFolderId).toBeNull();
  });

  it('DELETE /:id re-parents child folders and live sessions, then deletes the folder', async () => {
    const res = await request(app).delete('/api/chat-folders/f-root').set('x-test-user', USER_A);
    expect(res.status).toBe(200);

    expect(fake.container('chat-folders').get('f-root')).toBeUndefined();
    // child folder re-parented to the deleted folder's parent (null)
    expect(fake.container('chat-folders').get('f-child')!.parentFolderId).toBeNull();
    // live session re-parented; soft-deleted session and other users' sessions untouched
    expect(fake.container('chat-sessions').get('sess-1')!.folderId).toBeNull();
    expect(fake.container('chat-sessions').get('sess-deleted')!.folderId).toBe('f-root');
    expect(fake.container('chat-sessions').get('sess-b')!.folderId).toBe('f-root');
  });

  it('DELETE /:id is owner-only', async () => {
    const res = await request(app).delete('/api/chat-folders/f-root').set('x-test-user', USER_B);
    expect(res.status).toBe(404);
    expect(fake.container('chat-folders').get('f-root')).toBeDefined();
  });
});
