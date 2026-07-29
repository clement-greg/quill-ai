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
    | { stage: 'checking'; total: number; webCheckCount: number; truncated: boolean; searchAvailable: boolean }
    | undefined;
}

/** The claims actually sent out for a web double-check. */
function groundedClaims(): string[] {
  const sent = grounding.groundClaims.mock.calls[0]?.[0] as { claim: string }[] | undefined;
  return (sent ?? []).map(c => c.claim);
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
    expect(events[1]).toEqual({
      stage: 'checking', total: 2, webCheckCount: 0, truncated: false, searchAvailable: false,
    });
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
        findings: [{ claim: 'Rome is on the Tiber.', verdict: 'verified', confidence: 55, explanation: 'It is.' }],
      });
      groundsWith([null]);

      const res = await post({ text: CHAPTER });
      expect(findingsOf(res.text)[0]).toMatchObject({ verdict: 'verified', confidence: 55, grounded: false });
      expect(findingsOf(res.text)[0].sources).toBeUndefined();
    });

    describe('the low-confidence gate', () => {
      it('only double-checks claims below high confidence, reporting the rest at once', async () => {
        modelReplies({
          findings: [
            { claim: 'Confident dispute.', verdict: 'disputed', confidence: 95, explanation: 'Sure.' },
            { claim: 'Borderline claim.', verdict: 'verified', confidence: 79, explanation: 'Fairly sure.' },
            { claim: 'Exactly at the line.', verdict: 'verified', confidence: 80, explanation: 'Sure.' },
            { claim: 'Shaky claim.', verdict: 'verified', confidence: 40, explanation: 'Not sure.' },
          ],
        });
        groundsWith([null, null]);

        const res = await post({ text: CHAPTER });
        expect(groundedClaims().sort()).toEqual(['Borderline claim.', 'Shaky claim.']);
        expect(checkingEvent(res.text)).toMatchObject({ total: 4, webCheckCount: 2 });
        // Every claim is still reported, checked or not.
        expect(findingsOf(res.text)).toHaveLength(4);
      });

      it('always double-checks an unverifiable claim, however confident the model was', async () => {
        modelReplies({
          findings: [{
            claim: "Can't settle this one.", verdict: 'unverifiable', confidence: 99,
            explanation: 'Beyond general knowledge.', remedy: 'Look it up.',
          }],
        });
        groundsWith([grounded({ verdict: 'verified', explanation: 'Sources settle it.', remedy: '' })]);

        const res = await post({ text: CHAPTER });
        expect(groundedClaims()).toEqual(["Can't settle this one."]);
        expect(findingsOf(res.text)[0]).toMatchObject({ verdict: 'verified', grounded: true });
      });

      it('skips search entirely when every claim came back confident', async () => {
        modelReplies({
          findings: [
            { claim: 'Confident A.', verdict: 'verified', confidence: 100, explanation: 'Sure.' },
            { claim: 'Confident B.', verdict: 'disputed', confidence: 88, explanation: 'Sure.' },
          ],
        });

        const res = await post({ text: CHAPTER });
        expect(grounding.groundClaims).not.toHaveBeenCalled();
        expect(checkingEvent(res.text)).toMatchObject({ searchAvailable: true, webCheckCount: 0 });
        expect(findingsOf(res.text).map(f => f.grounded)).toEqual([false, false]);
      });
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

    it('emits confident findings first, then each lookup as it settles', async () => {
      modelReplies({
        findings: [
          { claim: 'Confident claim.', verdict: 'verified', confidence: 99, explanation: 'Fine.' },
          { claim: 'Unsure A.', verdict: 'verified', confidence: 60, explanation: 'Hmm.' },
          { claim: 'Unsure B.', verdict: 'verified', confidence: 50, explanation: 'Hmm.' },
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
      // Settled claims lead; checked ones follow in completion order. The client sorts.
      expect(findingsOf(res.text).map(f => [f.claim, f.verdict, f.grounded])).toEqual([
        ['Confident claim.', 'verified', false],
        ['Unsure B.', 'disputed', true],
        ['Unsure A.', 'verified', false],
      ]);
    });

    it('double-checks at most 20 claims but still reports the rest, unchecked', async () => {
      modelReplies({
        findings: Array.from({ length: 25 }, (_, i) => ({
          // All below the confidence gate, so all 25 qualify for a web check.
          claim: `Claim ${i}.`, verdict: 'verified', confidence: 79 - i, explanation: 'Hmm.',
        })),
      });
      groundsWith(Array.from({ length: 20 }, () => null));

      const res = await post({ text: CHAPTER });
      const findings = findingsOf(res.text);
      expect(findings).toHaveLength(25);
      expect(checkingEvent(res.text)).toMatchObject({ total: 25, webCheckCount: 20 });
      const sent = groundedClaims();
      expect(sent).toHaveLength(20);
      // Taken in report order, so the highest-priority claims get the budget.
      expect(sent[0]).toBe('Claim 0.');
      expect(sent[19]).toBe('Claim 19.');
      // The 5 that missed the budget are reported up front, unchecked.
      expect(findings.slice(0, 5).map(f => f.claim))
        .toEqual(['Claim 20.', 'Claim 21.', 'Claim 22.', 'Claim 23.', 'Claim 24.']);
    });

    it('gives grounding a cancellation check so a closed connection stops the run', async () => {
      modelReplies({
        findings: [{ claim: 'Claim A.', verdict: 'verified', confidence: 30, explanation: 'Hmm.' }],
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
