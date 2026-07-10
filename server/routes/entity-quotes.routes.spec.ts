import request from 'supertest';

jest.mock('../services/cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});
jest.mock('openai', () => ({
  AzureOpenAI: jest.fn(() => ({ chat: { completions: { create: jest.fn() } } })),
}));

import entityQuotesRoutes from './entity-quotes.routes';
import { makeTestApp, USER_A, USER_B } from '../testing/test-app';
import { FakeCosmos } from '../testing/fake-cosmos';

const fake = jest.requireMock('../services/cosmos').__fake as FakeCosmos;
const app = makeTestApp('/api/entity-quotes', entityQuotesRoutes);

function seed(): void {
  fake.reset();
  fake.container('entity-quotes').seed(
    { id: 'q-hi', chapterId: 'ch-1', entityId: 'e-1', text: 'Hello there', isHighlighted: true, owner: USER_A },
    { id: 'q-old', chapterId: 'ch-1', entityId: 'e-1', text: 'An old line', isHighlighted: false, owner: USER_A },
    { id: 'q-bob', chapterId: 'ch-1', entityId: 'e-1', text: 'Bob quote', isHighlighted: false, owner: USER_B },
  );
}

beforeEach(seed);

describe('entity-quotes routes', () => {
  it('GET /entity/:entityId returns only the caller’s quotes', async () => {
    const asA = await request(app).get('/api/entity-quotes/entity/e-1').set('x-test-user', USER_A);
    expect(asA.status).toBe(200);
    expect(asA.body.map((q: { id: string }) => q.id).sort()).toEqual(['q-hi', 'q-old']);

    const asB = await request(app).get('/api/entity-quotes/entity/e-1').set('x-test-user', USER_B);
    expect(asB.body.map((q: { id: string }) => q.id)).toEqual(['q-bob']);
  });

  it('POST / validates input and creates a manual quote owned by the caller', async () => {
    const invalid = await request(app)
      .post('/api/entity-quotes')
      .set('x-test-user', USER_A)
      .send({ entityId: 'e-1', text: '  ' });
    expect(invalid.status).toBe(400);

    const res = await request(app)
      .post('/api/entity-quotes')
      .set('x-test-user', USER_A)
      .send({ entityId: 'e-1', text: '  To be trimmed  ' });
    expect(res.status).toBe(201);
    expect(res.body.text).toBe('To be trimmed');
    expect(res.body.owner).toBe(USER_A);
    expect(res.body.isHighlighted).toBe(false);
    expect(res.body.chapterId).toBe('');
  });

  it('PATCH /:id/text updates for the owner and 404s for strangers', async () => {
    const missingBody = await request(app)
      .patch('/api/entity-quotes/q-hi/text')
      .set('x-test-user', USER_A)
      .send({ entityId: 'e-1' });
    expect(missingBody.status).toBe(400);

    const stranger = await request(app)
      .patch('/api/entity-quotes/q-hi/text')
      .set('x-test-user', USER_B)
      .send({ entityId: 'e-1', text: 'Hijacked' });
    expect(stranger.status).toBe(404);
    expect(fake.container('entity-quotes').get('q-hi')!.text).toBe('Hello there');

    const owner = await request(app)
      .patch('/api/entity-quotes/q-hi/text')
      .set('x-test-user', USER_A)
      .send({ entityId: 'e-1', text: 'Hello again' });
    expect(owner.status).toBe(200);
    expect(owner.body.text).toBe('Hello again');
  });

  it('PATCH /:id/highlight validates the flag and is owner-only', async () => {
    const invalid = await request(app)
      .patch('/api/entity-quotes/q-hi/highlight')
      .set('x-test-user', USER_A)
      .send({ entityId: 'e-1', isHighlighted: 'yes' });
    expect(invalid.status).toBe(400);

    const stranger = await request(app)
      .patch('/api/entity-quotes/q-hi/highlight')
      .set('x-test-user', USER_B)
      .send({ entityId: 'e-1', isHighlighted: false });
    expect(stranger.status).toBe(404);

    const owner = await request(app)
      .patch('/api/entity-quotes/q-hi/highlight')
      .set('x-test-user', USER_A)
      .send({ entityId: 'e-1', isHighlighted: false });
    expect(owner.status).toBe(200);
    expect(fake.container('entity-quotes').get('q-hi')!.isHighlighted).toBe(false);
  });

  it('DELETE /:id requires entityId and is owner-only', async () => {
    const noEntity = await request(app).delete('/api/entity-quotes/q-hi').set('x-test-user', USER_A).send({});
    expect(noEntity.status).toBe(400);

    const stranger = await request(app)
      .delete('/api/entity-quotes/q-hi')
      .set('x-test-user', USER_B)
      .send({ entityId: 'e-1' });
    expect(stranger.status).toBe(404);
    expect(fake.container('entity-quotes').get('q-hi')).toBeDefined();

    const owner = await request(app)
      .delete('/api/entity-quotes/q-hi')
      .set('x-test-user', USER_A)
      .send({ entityId: 'e-1' });
    expect(owner.status).toBe(200);
    expect(fake.container('entity-quotes').get('q-hi')).toBeUndefined();
  });

  describe('POST /sync', () => {
    it('validates the payload', async () => {
      const res = await request(app)
        .post('/api/entity-quotes/sync')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-1' });
      expect(res.status).toBe(400);
    });

    it('keeps matching quotes (preserving highlight), inserts new ones, deletes removed ones', async () => {
      const res = await request(app)
        .post('/api/entity-quotes/sync')
        .set('x-test-user', USER_A)
        .send({
          chapterId: 'ch-1',
          quotes: [
            { entityId: 'e-1', text: '  HELLO THERE ' }, // matches q-hi after normalization
            { entityId: 'e-1', text: 'A brand new line' },
          ],
        });
      expect(res.status).toBe(200);

      const byText = new Map(res.body.map((q: { text: string; isHighlighted: boolean; id: string }) => [q.text, q]));
      expect((byText.get('Hello there') as { isHighlighted: boolean }).isHighlighted).toBe(true);
      expect(byText.has('A brand new line')).toBe(true);
      expect(res.body).toHaveLength(2);

      // q-old was dropped from the chapter — deleted from storage
      expect(fake.container('entity-quotes').get('q-old')).toBeUndefined();
      // survivor kept, new quote persisted un-highlighted
      expect(fake.container('entity-quotes').get('q-hi')).toBeDefined();
      const inserted = byText.get('A brand new line') as { id: string; isHighlighted: boolean };
      expect(inserted.isHighlighted).toBe(false);
      expect(fake.container('entity-quotes').get(inserted.id)!.owner).toBe(USER_A);
    });

    it('never touches another user’s quotes for the same chapter', async () => {
      await request(app)
        .post('/api/entity-quotes/sync')
        .set('x-test-user', USER_A)
        .send({ chapterId: 'ch-1', quotes: [] });
      expect(fake.container('entity-quotes').get('q-bob')).toBeDefined();
      expect(fake.container('entity-quotes').get('q-hi')).toBeUndefined();
      expect(fake.container('entity-quotes').get('q-old')).toBeUndefined();
    });
  });
});
