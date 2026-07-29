import request from 'supertest';

const create = jest.fn();
jest.mock('openai', () => ({
  AzureOpenAI: jest.fn(() => ({ chat: { completions: { create } } })),
}));
// Grounding is exercised in google-search-grounding.spec.ts; here it is stubbed so
// the route's own merge/sort/fallback logic is what's under test.
jest.mock('../services/google-search-grounding', () => ({
  isSearchGroundingEnabled: jest.fn(() => false),
  groundClaims: jest.fn(async (claims: unknown[]) => claims.map(() => null)),
}));

import factCheckRoutes from './fact-check.routes';
import { makeTestApp, USER_A } from '../testing/test-app';
import { FactCheckFinding } from '../../shared/models/fact-check.model';
import { GroundedVerdict } from '../services/google-search-grounding';

const grounding = jest.requireMock('../services/google-search-grounding') as {
  isSearchGroundingEnabled: jest.Mock;
  groundClaims: jest.Mock;
};

const app = makeTestApp('/api/fact-check', factCheckRoutes);

/** Makes the mocked model reply with `payload` as its JSON message content. */
function modelReplies(payload: unknown): void {
  create.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  });
}

function post(body: object) {
  return request(app).post('/api/fact-check').set('x-test-user', USER_A).send(body);
}

const CHAPTER = 'The Titanic sank in 1913. Rome lies on the Tiber. Elowen drew her starblade.';

beforeEach(() => {
  create.mockReset();
  grounding.isSearchGroundingEnabled.mockReset().mockReturnValue(false);
  grounding.groundClaims.mockReset().mockImplementation(async (claims: unknown[]) => claims.map(() => null));
});

describe('fact-check routes', () => {
  it('rejects blank text without calling the model', async () => {
    const res = await post({ text: '   ' });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns findings with disputed first, then unverifiable, then verified', async () => {
    modelReplies({
      findings: [
        { claim: 'Rome is on the Tiber.', quote: 'Rome lies on the Tiber.', category: 'geography', verdict: 'verified', confidence: 99, explanation: 'It is.' },
        { claim: 'A 1913 timetable existed.', category: 'history', verdict: 'unverifiable', confidence: 40, explanation: 'Too obscure.', remedy: 'Check a timetable.' },
        { claim: 'The Titanic sank in 1913.', quote: 'The Titanic sank in 1913.', category: 'history', verdict: 'disputed', confidence: 98, explanation: 'It sank in 1912.', remedy: "Change '1913' to '1912'." },
      ],
    });

    const res = await post({ text: CHAPTER });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.findings.map((f: FactCheckFinding) => f.verdict))
      .toEqual(['disputed', 'unverifiable', 'verified']);
    expect(res.body.findings[0].remedy).toBe("Change '1913' to '1912'.");
    expect(res.body.findings.every((f: FactCheckFinding) => !!f.id)).toBe(true);
  });

  it('passes known entity names to the model so invented names are skipped', async () => {
    modelReplies({ findings: [] });
    await post({ text: CHAPTER, knownEntityNames: ['Elowen', '  ', 42] });

    const userMessage = create.mock.calls[0][0].messages[1].content as string;
    expect(userMessage).toContain('Elowen');
    expect(userMessage).toContain(CHAPTER);
  });

  it('drops a quote that is not verbatim in the chapter but keeps the finding', async () => {
    modelReplies({
      findings: [{
        claim: 'The Titanic sank in 1913.',
        quote: 'the titanic went down in 1913',
        category: 'history', verdict: 'disputed', confidence: 95,
        explanation: 'It sank in 1912.', remedy: 'Use 1912.',
      }],
    });

    const res = await post({ text: CHAPTER });
    expect(res.body.findings).toHaveLength(1);
    expect(res.body.findings[0].quote).toBeUndefined();
  });

  it('normalizes bad categories and confidence, and strips remedies from verified findings', async () => {
    modelReplies({
      findings: [{
        claim: 'Rome is on the Tiber.', category: 'vibes', verdict: 'verified',
        confidence: 250, explanation: 'It is.', remedy: 'Nothing to do.',
      }],
    });

    const res = await post({ text: CHAPTER });
    expect(res.body.findings[0]).toMatchObject({ category: 'other', confidence: 100 });
    expect(res.body.findings[0].remedy).toBeUndefined();
  });

  it('skips findings missing a claim, explanation, or valid verdict, and dedupes repeats', async () => {
    modelReplies({
      findings: [
        { claim: '', verdict: 'disputed', confidence: 90, explanation: 'No claim.' },
        { claim: 'No explanation given.', verdict: 'disputed', confidence: 90, explanation: '' },
        { claim: 'Bad verdict.', verdict: 'mostly true', confidence: 90, explanation: 'Hmm.' },
        { claim: 'Rome is on the Tiber.', verdict: 'verified', confidence: 99, explanation: 'It is.' },
        { claim: 'rome is on the   tiber.', verdict: 'verified', confidence: 80, explanation: 'Repeat.' },
      ],
    });

    const res = await post({ text: CHAPTER });
    expect(res.body.findings).toHaveLength(1);
    expect(res.body.findings[0].confidence).toBe(99);
  });

  it('flags truncation and sends only the leading portion of a long chapter', async () => {
    modelReplies({ findings: [] });
    const res = await post({ text: 'a'.repeat(20050) });

    expect(res.body.truncated).toBe(true);
    const userMessage = create.mock.calls[0][0].messages[1].content as string;
    expect(userMessage).toContain('a'.repeat(20000));
    expect(userMessage).not.toContain('a'.repeat(20001));
  });

  it('reports search as unavailable and grounds nothing when Gemini is not configured', async () => {
    modelReplies({
      findings: [{ claim: 'Rome is on the Tiber.', verdict: 'verified', confidence: 99, explanation: 'It is.' }],
    });

    const res = await post({ text: CHAPTER });
    expect(res.body).toMatchObject({ searchAvailable: false, groundedCount: 0 });
    expect(res.body.findings[0].grounded).toBe(false);
    expect(grounding.groundClaims).not.toHaveBeenCalled();
  });

  describe('with web search grounding enabled', () => {
    const grounded = (over: Partial<GroundedVerdict> = {}): GroundedVerdict => ({
      verdict: 'disputed', confidence: 97, explanation: 'Sources say 1912.',
      remedy: 'Use 1912.', sources: [{ title: 'Britannica', url: 'https://example.org/titanic' }],
      searchQueries: ['when did the titanic sink'], ...over,
    });

    beforeEach(() => grounding.isSearchGroundingEnabled.mockReturnValue(true));

    it('replaces the verdict with the grounded one and attaches its sources', async () => {
      modelReplies({
        findings: [{
          claim: 'The Titanic sank in 1913.', quote: 'The Titanic sank in 1913.',
          category: 'history', verdict: 'unverifiable', confidence: 40, explanation: 'Not sure.',
          remedy: 'Look it up.',
        }],
      });
      grounding.groundClaims.mockResolvedValueOnce([grounded()]);

      const res = await post({ text: CHAPTER });
      expect(res.body.groundedCount).toBe(1);
      expect(res.body.findings[0]).toMatchObject({
        verdict: 'disputed', confidence: 97, explanation: 'Sources say 1912.',
        remedy: 'Use 1912.', grounded: true,
        sources: [{ title: 'Britannica', url: 'https://example.org/titanic' }],
      });
      // Only the claim and its quote go to Google — never the chapter text.
      expect(grounding.groundClaims).toHaveBeenCalledWith([
        { claim: 'The Titanic sank in 1913.', quote: 'The Titanic sank in 1913.' },
      ]);
    });

    it('keeps the knowledge-based verdict when a claim cannot be grounded', async () => {
      modelReplies({
        findings: [{ claim: 'Rome is on the Tiber.', verdict: 'verified', confidence: 88, explanation: 'It is.' }],
      });
      grounding.groundClaims.mockResolvedValueOnce([null]);

      const res = await post({ text: CHAPTER });
      expect(res.body).toMatchObject({ searchAvailable: true, groundedCount: 0 });
      expect(res.body.findings[0]).toMatchObject({ verdict: 'verified', confidence: 88, grounded: false });
      expect(res.body.findings[0].sources).toBeUndefined();
    });

    it('drops a stale remedy when grounding clears the claim', async () => {
      modelReplies({
        findings: [{
          claim: 'The Titanic sank in 1912.', verdict: 'disputed', confidence: 70,
          explanation: 'Thought it was 1913.', remedy: 'Change to 1913.',
        }],
      });
      grounding.groundClaims.mockResolvedValueOnce([
        grounded({ verdict: 'verified', explanation: 'Sources confirm 1912.', remedy: '' }),
      ]);

      const res = await post({ text: CHAPTER });
      expect(res.body.findings[0].verdict).toBe('verified');
      expect(res.body.findings[0].remedy).toBeUndefined();
    });

    it('re-sorts after grounding so a newly disputed claim leads the report', async () => {
      modelReplies({
        findings: [
          { claim: 'Claim A.', verdict: 'verified', confidence: 99, explanation: 'Fine.' },
          { claim: 'Claim B.', verdict: 'verified', confidence: 60, explanation: 'Fine.' },
        ],
      });
      grounding.groundClaims.mockResolvedValueOnce([null, grounded({ confidence: 90 })]);

      const res = await post({ text: CHAPTER });
      expect(res.body.findings.map((f: FactCheckFinding) => [f.claim, f.verdict]))
        .toEqual([['Claim B.', 'disputed'], ['Claim A.', 'verified']]);
    });

    it('grounds at most 20 claims, taking them in report order', async () => {
      modelReplies({
        findings: Array.from({ length: 25 }, (_, i) => ({
          claim: `Claim ${i}.`, verdict: 'verified', confidence: 100 - i, explanation: 'Fine.',
        })),
      });
      grounding.groundClaims.mockResolvedValueOnce(Array.from({ length: 20 }, () => null));

      const res = await post({ text: CHAPTER });
      expect(res.body.findings).toHaveLength(25);
      const sent = grounding.groundClaims.mock.calls[0][0] as { claim: string }[];
      expect(sent).toHaveLength(20);
      expect(sent[0].claim).toBe('Claim 0.');
      expect(sent[19].claim).toBe('Claim 19.');
    });
  });

  it('returns 502 on unparseable model output and 500 when the model call fails', async () => {
    create.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] });
    expect((await post({ text: CHAPTER })).status).toBe(502);

    create.mockRejectedValueOnce(new Error('foundry down'));
    const failed = await post({ text: CHAPTER });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBeTruthy();
  });
});
