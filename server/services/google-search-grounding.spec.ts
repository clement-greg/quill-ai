import config from '../config';
import {
  GEMINI_SEARCH_MODEL_DEFAULT,
  groundClaim,
  groundClaims,
  isSearchGroundingEnabled,
} from './google-search-grounding';

/** The mocked config is a plain object, so specs can toggle the API key on it. */
const testConfig = config as unknown as { googleAIStudio: { apiKey: string; searchModel?: string } };

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

/** Builds a Gemini generateContent response carrying `text` and grounding metadata. */
function geminiReply(text: string, opts: { queries?: string[]; urls?: [string, string][] } = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { parts: [{ text }] },
        groundingMetadata: {
          webSearchQueries: opts.queries ?? ['a search'],
          groundingChunks: (opts.urls ?? []).map(([title, uri]) => ({ web: { title, uri } })),
        },
      }],
    }),
  };
}

const GOOD_JSON = JSON.stringify({
  verdict: 'disputed', confidence: 96,
  explanation: 'Contemporary sources put the sinking in 1912.',
  remedy: "Change '1913' to '1912'.",
});

beforeEach(() => {
  fetchMock.mockReset();
  testConfig.googleAIStudio.apiKey = 'test-gemini-key';
  delete testConfig.googleAIStudio.searchModel;
});

describe('isSearchGroundingEnabled', () => {
  it('is driven by whether an API key is configured', () => {
    expect(isSearchGroundingEnabled()).toBe(true);
    testConfig.googleAIStudio.apiKey = '';
    expect(isSearchGroundingEnabled()).toBe(false);
  });
});

describe('groundClaim', () => {
  it('calls the configured model with the google_search tool and returns the verdict', async () => {
    fetchMock.mockResolvedValueOnce(
      geminiReply(GOOD_JSON, { queries: ['titanic sinking date'], urls: [['Britannica', 'https://b.example/t']] }),
    );

    const result = await groundClaim({ claim: 'The Titanic sank in 1913.', quote: 'sank in 1913' });

    expect(result).toEqual({
      verdict: 'disputed', confidence: 96,
      explanation: 'Contemporary sources put the sinking in 1912.',
      remedy: "Change '1913' to '1912'.",
      sources: [{ title: 'Britannica', url: 'https://b.example/t' }],
      searchQueries: ['titanic sinking date'],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/${GEMINI_SEARCH_MODEL_DEFAULT}:generateContent`);
    expect(url).toContain('key=test-gemini-key');
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
    const prompt = body.contents[0].parts[0].text as string;
    expect(prompt).toContain('The Titanic sank in 1913.');
    expect(prompt).toContain('sank in 1913');
  });

  it('honours a configured search model', async () => {
    testConfig.googleAIStudio.searchModel = 'gemini-9-flash';
    fetchMock.mockResolvedValueOnce(geminiReply(GOOD_JSON));

    await groundClaim({ claim: 'Anything.' });
    expect(fetchMock.mock.calls[0][0]).toContain('/gemini-9-flash:generateContent');
  });

  it('returns null without calling Gemini when no API key is configured', async () => {
    testConfig.googleAIStudio.apiKey = '';
    expect(await groundClaim({ claim: 'Anything.' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses a reply wrapped in code fences and drops a remedy on a verified claim', async () => {
    fetchMock.mockResolvedValueOnce(geminiReply(
      '```json\n{"verdict":"verified","confidence":91,"explanation":"Sources agree.","remedy":"none"}\n```',
    ));

    const result = await groundClaim({ claim: 'Rome is on the Tiber.' });
    expect(result).toMatchObject({ verdict: 'verified', confidence: 91, remedy: '' });
  });

  it('clamps an out-of-range confidence and dedupes and caps sources', async () => {
    fetchMock.mockResolvedValueOnce(geminiReply(
      JSON.stringify({ verdict: 'verified', confidence: 140, explanation: 'Sure.' }),
      {
        urls: [
          ['One', 'https://one.example'], ['One again', 'https://one.example'],
          ['Two', 'https://two.example'], ['Three', 'https://three.example'],
          ['Four', 'https://four.example'], ['Five', 'https://five.example'],
        ],
      },
    ));

    const result = await groundClaim({ claim: 'Anything.' });
    expect(result?.confidence).toBe(100);
    expect(result?.sources.map(s => s.url)).toEqual([
      'https://one.example', 'https://two.example', 'https://three.example', 'https://four.example',
    ]);
  });

  it('falls back to the URL when a source has no title', async () => {
    fetchMock.mockResolvedValueOnce(geminiReply(GOOD_JSON, { urls: [['', 'https://untitled.example']] }));
    const result = await groundClaim({ claim: 'Anything.' });
    expect(result?.sources).toEqual([{ title: 'https://untitled.example', url: 'https://untitled.example' }]);
  });

  it('returns null on a rate-limit response instead of throwing', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 429,
      json: async () => ({ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }),
    });

    expect(await groundClaim({ claim: 'Anything.' })).toBeNull();
  });

  it('returns null for an unusable reply: bad verdict, no explanation, or non-JSON', async () => {
    fetchMock.mockResolvedValueOnce(geminiReply(JSON.stringify({ verdict: 'mostly', confidence: 50, explanation: 'x' })));
    expect(await groundClaim({ claim: 'A.' })).toBeNull();

    fetchMock.mockResolvedValueOnce(geminiReply(JSON.stringify({ verdict: 'verified', confidence: 50, explanation: '' })));
    expect(await groundClaim({ claim: 'B.' })).toBeNull();

    fetchMock.mockResolvedValueOnce(geminiReply('I could not find anything.'));
    expect(await groundClaim({ claim: 'C.' })).toBeNull();
  });

  it('returns null when the request throws', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect(await groundClaim({ claim: 'Anything.' })).toBeNull();
  });
});

describe('groundClaims', () => {
  it('returns results index-aligned with the claims, nulls included', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(geminiReply(GOOD_JSON))
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) })
      .mockResolvedValueOnce(geminiReply(JSON.stringify({ verdict: 'verified', confidence: 80, explanation: 'Fine.' })));

    const results = await groundClaims(
      [{ claim: 'A.' }, { claim: 'B.' }, { claim: 'C.' }],
      { concurrency: 1 },
    );
    expect(results.map(r => r?.verdict ?? null)).toEqual(['disputed', null, 'verified']);
  });

  it('reports each claim through onResult as it settles', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(geminiReply(GOOD_JSON))
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });

    const seen: [number, string | null][] = [];
    await groundClaims([{ claim: 'A.' }, { claim: 'B.' }], {
      concurrency: 1,
      onResult: (index, verdict) => seen.push([index, verdict?.verdict ?? null]),
    });

    expect(seen).toEqual([[0, 'disputed'], [1, null]]);
  });

  it('stops taking new claims once isCancelled returns true', async () => {
    fetchMock.mockResolvedValue(geminiReply(GOOD_JSON));
    let cancelled = false;

    const results = await groundClaims(
      Array.from({ length: 5 }, (_, i) => ({ claim: `Claim ${i}.` })),
      {
        concurrency: 1,
        // Cancel as soon as the first lookup has been reported.
        onResult: () => { cancelled = true; },
        isCancelled: () => cancelled,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map(r => r?.verdict ?? null)).toEqual(['disputed', null, null, null, null]);
  });

  it('never runs more than `concurrency` lookups at once', async () => {
    let inFlight = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight--;
      return geminiReply(GOOD_JSON);
    });

    const claims = Array.from({ length: 9 }, (_, i) => ({ claim: `Claim ${i}.` }));
    const results = await groundClaims(claims, { concurrency: 3 });

    expect(results.every(r => r !== null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(peak).toBe(3);
  });

  it('handles an empty claim list without calling Gemini', async () => {
    expect(await groundClaims([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
