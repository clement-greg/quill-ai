import request from 'supertest';

const create = jest.fn();
jest.mock('openai', () => ({
  AzureOpenAI: jest.fn(() => ({ chat: { completions: { create } } })),
}));
// Grounding is exercised in google-search-grounding.spec.ts; here it is stubbed so
// the route's own streaming, merge and fallback logic is what's under test.
jest.mock('../services/google-search-grounding', () => ({
  isSearchGroundingEnabled: jest.fn(() => false),
  groundClaims: jest.fn(),
}));

import factCheckRoutes from './fact-check.routes';
import { makeTestApp, USER_A } from '../testing/test-app';
import { FactCheckFinding, FactCheckStreamEvent } from '../../shared/models/fact-check.model';
import { GroundClaimsOptions, GroundedVerdict } from '../services/google-search-grounding';

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

/**
 * Stubs grounding to resolve each claim to the matching entry of `verdicts`,
 * reporting each through `onResult` the way the real pool does.
 */
function groundsWith(verdicts: (GroundedVerdict | null)[]): void {
  grounding.groundClaims.mockImplementationOnce(
    async (claims: unknown[], options: GroundClaimsOptions) => {
      const settled = claims.map((_, i) => verdicts[i] ?? null);
      settled.forEach((verdict, i) => options.onResult?.(i, verdict));
      return settled;
    },
  );
}

function post(body: object) {
  return request(app).post('/api/fact-check').set('x-test-user', USER_A).send(body);
}

/** Parses an SSE body into the events it carried, dropping the [DONE] marker. */
function eventsOf(body: string): FactCheckStreamEvent[] {
  return body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice(6))
    .filter(data => data !== '[DONE]')
    .map(data => JSON.parse(data) as FactCheckStreamEvent);
}

function findingsOf(body: string): FactCheckFinding[] {
  return eventsOf(body).flatMap(e => ('finding' in e ? [e.finding] : []));
}

/** The `stage: 'checking'` event, which carries the run's totals. */
function checkingEvent(body: string) {
  return eventsOf(body).find(e => 'stage' in e && e.stage === 'checking') as
    | { stage: 'checking'; total: number; truncated: boolean; searchAvailable: boolean }
    | undefined;
}

const CHAPTER = 'The Titanic sank in 1913. Rome lies on the Tiber. Elowen drew her starblade.';

beforeEach(() => {
  create.mockReset();
  grounding.isSearchGroundingEnabled.mockReset().mockReturnValue(false);
  grounding.groundClaims.mockReset();
});

describe('fact-check routes', () => {
  it('rejects blank text without calling the model', async () => {
    const res = await post({ text: '   ' });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('streams an extracting stage, then totals, then one event per finding, then DONE', async () => {
    modelReplies({
      findings: [
        { claim: 'Rome is on the Tiber.', quote: 'Rome lies on the Tiber.', category: 'geography', verdict: 'verified', confidence: 99, explanation: 'It is.' },
        { claim: 'The Titanic sank in 1913.', quote: 'The Titanic sank in 1913.', category: 'history', verdict: 'disputed', confidence: 98, explanation: 'It sank in 1912.', remedy: "Change '1913' to '1912'." },
      ],
    });

    const res = await post({ text: CHAPTER });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data: [DONE]');

    const events = eventsOf(res.text);
    expect(events[0]).toEqual({ stage: 'extracting' });
    expect(events[1]).toEqual({ stage: 'checking', total: 2, truncated: false, searchAvailable: false });
    // Claims are emitted in grounding priority order: disputes first.
    expect(findingsOf(res.text).map(f => f.verdict)).toEqual(['disputed', 'verified']);
    expect(findingsOf(res.text)[0].remedy).toBe("Change '1913' to '1912'.");
    expect(findingsOf(res.text).every(f => !!f.id && f.grounded === false)).toBe(true);
  });

  it('passes known entity names to the model so invented names are skipped', async () => {
    modelReplies({ findings: [] });
    await post({ text: CHAPTER, knownEntityNames: ['Elowen', '  ', 42] });

    const userMessage = create.mock.calls[0][0].messages[1].content as string;
    expect(userMessage).toContain('Elowen');
    expect(userMessage).toContain(CHAPTER);
  });

  it('reports a claim count of zero when the chapter has no checkable claims', async () => {
    modelReplies({ findings: [] });
    const res = await post({ text: CHAPTER });
    expect(checkingEvent(res.text)).toMatchObject({ total: 0 });
    expect(findingsOf(res.text)).toEqual([]);
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
    expect(findingsOf(res.text)).toHaveLength(1);
    expect(findingsOf(res.text)[0].quote).toBeUndefined();
  });

  it('normalizes bad categories and confidence, and strips remedies from verified findings', async () => {
    modelReplies({
      findings: [{
        claim: 'Rome is on the Tiber.', category: 'vibes', verdict: 'verified',
        confidence: 250, explanation: 'It is.', remedy: 'Nothing to do.',
      }],
    });

    const res = await post({ text: CHAPTER });
    expect(findingsOf(res.text)[0]).toMatchObject({ category: 'other', confidence: 100 });
    expect(findingsOf(res.text)[0].remedy).toBeUndefined();
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
    expect(findingsOf(res.text)).toHaveLength(1);
    expect(findingsOf(res.text)[0].confidence).toBe(99);
  });

  it('flags truncation and sends only the leading portion of a long chapter', async () => {
    modelReplies({ findings: [] });
    const res = await post({ text: 'a'.repeat(20050) });

    expect(checkingEvent(res.text)).toMatchObject({ truncated: true });
    const userMessage = create.mock.calls[0][0].messages[1].content as string;
    expect(userMessage).toContain('a'.repeat(20000));
    expect(userMessage).not.toContain('a'.repeat(20001));
  });

  it('reports search as unavailable and grounds nothing when Gemini is not configured', async () => {
    modelReplies({
      findings: [{ claim: 'Rome is on the Tiber.', verdict: 'verified', confidence: 99, explanation: 'It is.' }],
    });

    const res = await post({ text: CHAPTER });
    expect(checkingEvent(res.text)).toMatchObject({ searchAvailable: false });
    expect(findingsOf(res.text)[0].grounded).toBe(false);
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
      groundsWith([grounded()]);

      const res = await post({ text: CHAPTER });
      expect(checkingEvent(res.text)).toMatchObject({ searchAvailable: true, total: 1 });
      expect(findingsOf(res.text)[0]).toMatchObject({
        verdict: 'disputed', confidence: 97, explanation: 'Sources say 1912.',
        remedy: 'Use 1912.', grounded: true,
        sources: [{ title: 'Britannica', url: 'https://example.org/titanic' }],
      });
      // Only the claim and its quote go to Google — never the chapter text.
      expect(grounding.groundClaims.mock.calls[0][0]).toEqual([
        { claim: 'The Titanic sank in 1913.', quote: 'The Titanic sank in 1913.' },
      ]);
    });

    it('keeps the knowledge-based verdict when a claim cannot be grounded', async () => {
      modelReplies({
        findings: [{ claim: 'Rome is on the Tiber.', verdict: 'verified', confidence: 88, explanation: 'It is.' }],
      });
      groundsWith([null]);

      const res = await post({ text: CHAPTER });
      expect(findingsOf(res.text)[0]).toMatchObject({ verdict: 'verified', confidence: 88, grounded: false });
      expect(findingsOf(res.text)[0].sources).toBeUndefined();
    });

    it('drops a stale remedy when grounding clears the claim', async () => {
      modelReplies({
        findings: [{
          claim: 'The Titanic sank in 1912.', verdict: 'disputed', confidence: 70,
          explanation: 'Thought it was 1913.', remedy: 'Change to 1913.',
        }],
      });
      groundsWith([grounded({ verdict: 'verified', explanation: 'Sources confirm 1912.', remedy: '' })]);

      const res = await post({ text: CHAPTER });
      expect(findingsOf(res.text)[0].verdict).toBe('verified');
      expect(findingsOf(res.text)[0].remedy).toBeUndefined();
    });

    it('emits each finding as its own lookup settles, in completion order', async () => {
      modelReplies({
        findings: [
          { claim: 'Claim A.', verdict: 'verified', confidence: 99, explanation: 'Fine.' },
          { claim: 'Claim B.', verdict: 'verified', confidence: 60, explanation: 'Fine.' },
        ],
      });
      // B's lookup lands before A's.
      grounding.groundClaims.mockImplementationOnce(
        async (claims: unknown[], options: GroundClaimsOptions) => {
          options.onResult?.(1, grounded({ confidence: 90 }));
          options.onResult?.(0, null);
          return [null, grounded({ confidence: 90 })];
        },
      );

      const res = await post({ text: CHAPTER });
      // The stream preserves completion order; the client sorts for display.
      expect(findingsOf(res.text).map(f => [f.claim, f.verdict, f.grounded]))
        .toEqual([['Claim B.', 'disputed', true], ['Claim A.', 'verified', false]]);
    });

    it('grounds at most 20 claims but still reports the rest, ungrounded', async () => {
      modelReplies({
        findings: Array.from({ length: 25 }, (_, i) => ({
          claim: `Claim ${i}.`, verdict: 'verified', confidence: 100 - i, explanation: 'Fine.',
        })),
      });
      groundsWith(Array.from({ length: 20 }, () => null));

      const res = await post({ text: CHAPTER });
      const findings = findingsOf(res.text);
      expect(findings).toHaveLength(25);
      expect(checkingEvent(res.text)).toMatchObject({ total: 25 });
      const sent = grounding.groundClaims.mock.calls[0][0] as { claim: string }[];
      expect(sent).toHaveLength(20);
      expect(sent[0].claim).toBe('Claim 0.');
      expect(sent[19].claim).toBe('Claim 19.');
      expect(findings[24].claim).toBe('Claim 24.');
    });

    it('gives grounding a cancellation check so a closed connection stops the run', async () => {
      modelReplies({
        findings: [{ claim: 'Claim A.', verdict: 'verified', confidence: 90, explanation: 'Fine.' }],
      });
      groundsWith([null]);

      await post({ text: CHAPTER });
      const options = grounding.groundClaims.mock.calls[0][1] as GroundClaimsOptions;
      expect(typeof options.isCancelled).toBe('function');
      expect(options.isCancelled?.()).toBe(false);
    });
  });

  it('streams an error event when the model output is unreadable or the call fails', async () => {
    create.mockResolvedValueOnce({ choices: [{ message: { content: 'not json' } }] });
    const unreadable = await post({ text: CHAPTER });
    expect(eventsOf(unreadable.text)).toContainEqual(
      { error: 'The fact check came back unreadable — please try again.' },
    );

    create.mockRejectedValueOnce(new Error('foundry down'));
    const failed = await post({ text: CHAPTER });
    const errorEvent = eventsOf(failed.text).find(e => 'error' in e) as { error: string };
    expect(errorEvent.error).toBeTruthy();
  });
});
