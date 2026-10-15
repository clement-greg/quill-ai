jest.mock('./cosmos', () => {
  const { createFakeCosmos } = jest.requireActual('../testing/fake-cosmos');
  const fake = createFakeCosmos();
  return { getContainer: fake.getContainer, __fake: fake };
});

import config from '../config';
import { FakeCosmos, FakeDoc } from '../testing/fake-cosmos';
import { chatModelFor, deploymentFor, invalidateAiModelSettings, modelFor } from './ai-models';

const fake = jest.requireMock('./cosmos').__fake as FakeCosmos;

beforeAll(() => {
  config.foundry.lowModel = 'dep-luna';
  config.foundry.midModel = 'dep-terra';
  config.foundry.highModel = 'dep-sol';
});

beforeEach(() => {
  fake.reset();
  invalidateAiModelSettings();
});

async function storeSettings(doc: FakeDoc): Promise<void> {
  await fake.getContainer('user-settings').items.upsert(doc);
}

describe('deploymentFor', () => {
  it('maps each model key to its configured deployment', () => {
    expect(deploymentFor('luna')).toBe('dep-luna');
    expect(deploymentFor('terra')).toBe('dep-terra');
    expect(deploymentFor('sol')).toBe('dep-sol');
  });
});

describe('modelFor', () => {
  it('uses the operation default when the author has no settings', async () => {
    expect(await modelFor({ sub: 'u1' }, 'writingScan')).toBe('dep-luna');
    expect(await modelFor({ sub: 'u1' }, 'editorReview')).toBe('dep-terra');
  });

  it('uses the defaults when there is no user', async () => {
    expect(await modelFor(undefined, 'chat')).toBe('dep-luna');
  });

  it("honours the author's pick for an operation", async () => {
    await storeSettings({ id: 'u1', email: 'a@x.com', aiModels: { editorReview: 'sol', writingScan: 'terra' } });
    expect(await modelFor({ sub: 'u1' }, 'editorReview')).toBe('dep-sol');
    expect(await modelFor({ sub: 'u1' }, 'writingScan')).toBe('dep-terra');
    // Untouched operations keep their default.
    expect(await modelFor({ sub: 'u1' }, 'factCheck')).toBe('dep-terra');
  });

  it('finds the settings by email when only the owner email is known', async () => {
    await storeSettings({ id: 'u1', email: 'a@x.com', aiModels: { chapterSummary: 'sol' } });
    expect(await modelFor({ email: 'a@x.com' }, 'chapterSummary')).toBe('dep-sol');
  });

  it('ignores a stored value that is not a valid pick', async () => {
    await storeSettings({ id: 'u1', aiModels: { editorReview: 'gpt-9000' } });
    expect(await modelFor({ sub: 'u1' }, 'editorReview')).toBe('dep-terra');
  });

  it('serves cached picks until invalidated', async () => {
    await storeSettings({ id: 'u1', aiModels: { chat: 'terra' } });
    expect(await modelFor({ sub: 'u1' }, 'chat')).toBe('dep-terra');

    await storeSettings({ id: 'u1', aiModels: { chat: 'sol' } });
    expect(await modelFor({ sub: 'u1' }, 'chat')).toBe('dep-terra');

    invalidateAiModelSettings({ sub: 'u1' });
    expect(await modelFor({ sub: 'u1' }, 'chat')).toBe('dep-sol');
  });
});

describe('chatModelFor', () => {
  it('uses the model picked in the chat when valid', async () => {
    expect(await chatModelFor({ sub: 'u1' }, 'sol')).toBe('dep-sol');
  });

  it("falls back to the author's chat setting for a missing or unknown pick", async () => {
    await storeSettings({ id: 'u1', aiModels: { chat: 'terra' } });
    expect(await chatModelFor({ sub: 'u1' }, undefined)).toBe('dep-terra');
    expect(await chatModelFor({ sub: 'u1' }, 'gpt-4')).toBe('dep-terra');
  });
});

