import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { GrammarCheckService, GrammarError } from './grammar-check.service';
import { AuthFetchService } from '@app/core/services/auth-fetch.service';

/** jsdom does not layout text, so fake the element's innerText directly. */
function el(text: string): HTMLElement {
  return { innerText: text } as HTMLElement;
}

describe('GrammarCheckService', () => {
  let service: GrammarCheckService;
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [], suggestedEntities: [] }), { status: 200 }));
    TestBed.configureTestingModule({
      providers: [{ provide: AuthFetchService, useValue: { fetch: fetchStub } }],
    });
    service = TestBed.inject(GrammarCheckService);
  });

  describe('extractCheckableText', () => {
    it('returns the last two complete sentences', () => {
      const text = 'First one. Second one! Third one? Fourth one.';
      expect(service.extractCheckableText(el(text))).toBe('Third one? Fourth one.');
    });

    it('excludes a trailing incomplete sentence being typed', () => {
      const text = 'Done sentence. Another done one. still typing this';
      expect(service.extractCheckableText(el(text))).toBe('Done sentence. Another done one.');
    });

    it('returns a single sentence when only one is complete', () => {
      expect(service.extractCheckableText(el('Only one here.'))).toBe('Only one here.');
    });

    it('returns empty when no sentence has ended', () => {
      expect(service.extractCheckableText(el('no punctuation yet'))).toBe('');
      expect(service.extractCheckableText(el(''))).toBe('');
    });

    it('keeps closing quotes attached to the sentence', () => {
      const text = 'He waved. "Get down!" she yelled.';
      expect(service.extractCheckableText(el(text))).toBe('"Get down!" she yelled.');
    });
  });

  describe('check', () => {
    it('posts the text and known entity names', async () => {
      await service.check('The cat sat.', ['Mark']);
      const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/grammar/check');
      expect(JSON.parse(init.body as string)).toEqual({ text: 'The cat sat.', knownEntityNames: ['Mark'] });
    });

    it('returns the parsed errors and suggested entities', async () => {
      const errors: GrammarError[] = [{ text: 'teh', suggestion: 'the', message: 'Typo' }];
      fetchStub.mockResolvedValue(new Response(
        JSON.stringify({ errors, suggestedEntities: [{ name: 'Mark', type: 'PERSON', description: 'A captain' }] }),
        { status: 200 },
      ));
      const result = await service.check('teh cat');
      expect(result.errors).toEqual(errors);
      expect(result.suggestedEntities[0].name).toBe('Mark');
    });

    it('normalizes non-array fields to empty arrays', async () => {
      fetchStub.mockResolvedValue(new Response(JSON.stringify({ errors: null, suggestedEntities: 'bad' }), { status: 200 }));
      expect(await service.check('x')).toEqual({ errors: [], suggestedEntities: [] });
    });

    it('returns empty results on a non-ok response', async () => {
      fetchStub.mockResolvedValue(new Response('fail', { status: 500 }));
      expect(await service.check('x')).toEqual({ errors: [], suggestedEntities: [] });
    });

    it('returns empty results when the request is aborted or fails', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      fetchStub.mockRejectedValue(abortErr);
      expect(await service.check('x')).toEqual({ errors: [], suggestedEntities: [] });

      fetchStub.mockRejectedValue(new Error('network'));
      expect(await service.check('x')).toEqual({ errors: [], suggestedEntities: [] });
    });
  });
});
