import { getContainer } from './cosmos';
import { sanitizeForModeration, refreshRedactionTerms } from './content-sanitize';

jest.mock('./cosmos', () => ({ getContainer: jest.fn() }));

const readMock = jest.fn();
(getContainer as jest.Mock).mockReturnValue({
  item: () => ({ read: readMock }),
});

function stubTerms(terms: string[] | undefined): void {
  readMock.mockResolvedValue({ resource: terms ? { terms } : undefined });
}

describe('sanitizeForModeration', () => {
  beforeEach(() => {
    refreshRedactionTerms();
    readMock.mockReset();
  });

  it('redacts configured terms as whole words, case-insensitively', async () => {
    stubTerms(['grok']);
    const result = await sanitizeForModeration('Grok said grok, but grokking is fine.');
    expect(result).toBe('[redacted] said [redacted], but grokking is fine.');
  });

  it('redacts every occurrence of every term', async () => {
    stubTerms(['foo', 'bar']);
    const result = await sanitizeForModeration('foo bar foo');
    expect(result).toBe('[redacted] [redacted] [redacted]');
  });

  it('treats regex special characters in terms as literals', async () => {
    stubTerms(['a.b']);
    const result = await sanitizeForModeration('a.b happened, but axb did not');
    expect(result).toBe('[redacted] happened, but axb did not');
  });

  it('returns text unchanged when no terms are configured', async () => {
    stubTerms([]);
    expect(await sanitizeForModeration('anything at all')).toBe('anything at all');
  });

  it('returns text unchanged when the settings document is missing', async () => {
    stubTerms(undefined);
    expect(await sanitizeForModeration('anything at all')).toBe('anything at all');
  });

  it('loads the term list once and caches it across calls', async () => {
    stubTerms(['foo']);
    await sanitizeForModeration('foo');
    await sanitizeForModeration('foo again');
    expect(readMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches the term list after refreshRedactionTerms', async () => {
    stubTerms(['old']);
    expect(await sanitizeForModeration('old term')).toBe('[redacted] term');

    stubTerms(['new']);
    refreshRedactionTerms();
    expect(await sanitizeForModeration('old and new')).toBe('old and [redacted]');
    expect(readMock).toHaveBeenCalledTimes(2);
  });
});
