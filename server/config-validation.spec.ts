import { ChatTierConfig, missingChatTiers, warnIfChatTiersMissing } from './config-validation';

function configWith(tiers: Partial<NonNullable<ChatTierConfig['foundry']>>): ChatTierConfig {
  return { foundry: { lowModel: 'low', midModel: 'mid', highModel: 'high', ...tiers } };
}

describe('missingChatTiers', () => {
  it('reports nothing when every tier has a deployment name', () => {
    expect(missingChatTiers(configWith({}))).toEqual([]);
  });

  it.each([
    ['lowModel', 'FOUNDRY_LOW_MODEL'],
    ['midModel', 'FOUNDRY_MID_MODEL'],
    ['highModel', 'FOUNDRY_HIGH_MODEL'],
  ] as const)('names the env var behind a missing %s', (key, envVar) => {
    expect(missingChatTiers(configWith({ [key]: '' }))).toEqual([envVar]);
  });

  it('lists every missing tier, including when foundry is absent entirely', () => {
    expect(missingChatTiers({})).toEqual([
      'FOUNDRY_LOW_MODEL',
      'FOUNDRY_MID_MODEL',
      'FOUNDRY_HIGH_MODEL',
    ]);
  });
});

describe('warnIfChatTiersMissing', () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => error.mockRestore());

  it('stays quiet on a complete config', () => {
    warnIfChatTiersMissing(configWith({}));
    expect(error).not.toHaveBeenCalled();
  });

  it('names the missing var and the symptom it causes', () => {
    warnIfChatTiersMissing(configWith({ midModel: '' }));
    expect(error).toHaveBeenCalledTimes(1);
    const message = error.mock.calls[0][0] as string;
    expect(message).toContain('FOUNDRY_MID_MODEL');
    expect(message).toContain('AI error occurred');
  });

  it('does not throw, so the rest of the app still starts', () => {
    expect(() => warnIfChatTiersMissing({})).not.toThrow();
  });
});
