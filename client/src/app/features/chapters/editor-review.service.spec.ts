import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { EditorSuggestion } from '@shared/models';
import { EditorReviewService } from './editor-review.service';
import { AuthFetchService } from '@app/core/services/auth-fetch.service';

function makeSuggestion(overrides: Partial<EditorSuggestion> = {}): EditorSuggestion {
  return {
    id: 'sug-1',
    blockIndex: 0,
    originalText: 'teh cat',
    replacementText: 'the cat',
    type: 'replace',
    category: 'grammar',
    severity: 'medium',
    reason: 'Typo',
    ...overrides,
  };
}

/** Builds an SSE Response streaming one `data:` line per event. */
function sseResponse(events: object[]): Response {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n`).join('') + 'data: [DONE]\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('EditorReviewService', () => {
  let service: EditorReviewService;
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchStub = vi.fn(async () => sseResponse([]));
    TestBed.configureTestingModule({
      providers: [{ provide: AuthFetchService, useValue: { fetch: fetchStub } }],
    });
    service = TestBed.inject(EditorReviewService);
  });

  describe('run', () => {
    it('streams suggestions into the list as open, then clears running', async () => {
      fetchStub.mockResolvedValue(sseResponse([
        { suggestion: makeSuggestion({ id: 'a' }) },
        { suggestion: makeSuggestion({ id: 'b', severity: 'low' }) },
      ]));

      await service.run('ch-1', [{ index: 0, text: 'teh cat sat' }]);

      expect(service.running()).toBe(false);
      expect(service.error()).toBeNull();
      expect(service.suggestions().map(s => s.id)).toEqual(['a', 'b']);
      expect(service.suggestions().every(s => s.status === 'open')).toBe(true);
    });

    it('processes a final data line that arrives without a trailing newline', async () => {
      const body = `data: ${JSON.stringify({ suggestion: makeSuggestion({ id: 'last' }) })}`;
      fetchStub.mockResolvedValue(
        new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      );

      await service.run('ch-1', []);
      expect(service.suggestions().map(s => s.id)).toEqual(['last']);
    });

    it('replaces suggestions from a previous run', async () => {
      fetchStub.mockResolvedValue(sseResponse([{ suggestion: makeSuggestion({ id: 'old' }) }]));
      await service.run('ch-1', []);
      fetchStub.mockResolvedValue(sseResponse([{ suggestion: makeSuggestion({ id: 'new' }) }]));
      await service.run('ch-1', []);
      expect(service.suggestions().map(s => s.id)).toEqual(['new']);
    });

    it('surfaces a streamed error event', async () => {
      fetchStub.mockResolvedValue(sseResponse([{ error: 'Model overloaded' }]));
      await service.run('ch-1', []);
      expect(service.error()).toBe('Model overloaded');
    });

    it('sets an error when the request fails to start', async () => {
      fetchStub.mockResolvedValue(new Response('nope', { status: 500 }));
      await service.run('ch-1', []);
      expect(service.error()).toBe('Failed to start the review.');
      expect(service.running()).toBe(false);
    });

    it('sets a connection error when fetch throws', async () => {
      fetchStub.mockRejectedValue(new Error('network down'));
      await service.run('ch-1', []);
      expect(service.error()).toBe('Could not connect to the AI editor.');
      expect(service.running()).toBe(false);
    });

    it('skips malformed SSE chunks without dying', async () => {
      const body = 'data: {not json\ndata: ' + JSON.stringify({ suggestion: makeSuggestion({ id: 'ok' }) }) + '\n';
      fetchStub.mockResolvedValue(new Response(body, { status: 200 }));
      await service.run('ch-1', []);
      expect(service.suggestions().map(s => s.id)).toEqual(['ok']);
      expect(service.error()).toBeNull();
    });

    it('posts the chapter id and blocks to the review endpoint', async () => {
      await service.run('ch-9', [{ index: 0, text: 'Once upon a time.' }]);
      const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/chapter-editor-review');
      expect(JSON.parse(init.body as string)).toEqual({
        chapterId: 'ch-9',
        blocks: [{ index: 0, text: 'Once upon a time.' }],
      });
    });
  });

  describe('status management', () => {
    beforeEach(async () => {
      fetchStub.mockResolvedValue(sseResponse([
        { suggestion: makeSuggestion({ id: 'a' }) },
        { suggestion: makeSuggestion({ id: 'b', severity: 'low' }) },
        { suggestion: makeSuggestion({ id: 'c', severity: 'high' }) },
      ]));
      await service.run('ch-1', []);
    });

    it('markAccepted / markRejected / markOpen change only the target', () => {
      service.markAccepted('a');
      service.markRejected('b');
      expect(service.suggestions().map(s => s.status)).toEqual(['accepted', 'rejected', 'open']);
      service.markOpen('a');
      expect(service.suggestions().find(s => s.id === 'a')?.status).toBe('open');
    });

    it('hasOpenSuggestions reflects remaining open items', () => {
      expect(service.hasOpenSuggestions()).toBe(true);
      service.markAccepted('a');
      service.markRejected('b');
      service.markRejected('c');
      expect(service.hasOpenSuggestions()).toBe(false);
    });

    it('visible hides low severity unless showLow is set', () => {
      expect(service.visible(false).map(s => s.id)).toEqual(['a', 'c']);
      expect(service.visible(true).map(s => s.id)).toEqual(['a', 'b', 'c']);
    });

    it('openCount counts only open suggestions at the visible severity', () => {
      expect(service.openCount(false)).toBe(2);
      expect(service.openCount(true)).toBe(3);
      service.markAccepted('a');
      expect(service.openCount(false)).toBe(1);
    });

    it('updateSuggestion merges fields but preserves id, blockIndex and anchor', () => {
      service.updateSuggestion('a', {
        id: 'evil-new-id',
        blockIndex: 99,
        originalText: 'evil anchor',
        replacementText: 'better cat',
        reason: 'Refined',
      } as Partial<EditorSuggestion>);
      const updated = service.suggestions().find(s => s.reason === 'Refined')!;
      expect(updated.id).toBe('a');
      expect(updated.blockIndex).toBe(0);
      expect(updated.originalText).toBe('teh cat');
      expect(updated.replacementText).toBe('better cat');
    });

    it('clear empties the list and error', () => {
      service.clear();
      expect(service.suggestions()).toEqual([]);
      expect(service.error()).toBeNull();
      expect(service.running()).toBe(false);
    });
  });

  describe('auto-run requests', () => {
    it('consumeAutoRun returns true once for the requested chapter', () => {
      service.requestAutoRun('ch-5');
      expect(service.consumeAutoRun('ch-5')).toBe(true);
      expect(service.consumeAutoRun('ch-5')).toBe(false);
    });

    it('consumeAutoRun ignores other chapters and preserves the request', () => {
      service.requestAutoRun('ch-5');
      expect(service.consumeAutoRun('ch-other')).toBe(false);
      expect(service.consumeAutoRun('ch-5')).toBe(true);
    });
  });

  describe('refineSuggestion', () => {
    const payload = {
      chapterId: 'ch-1',
      blockText: 'teh cat sat',
      originalText: 'teh cat',
      currentReplacement: 'the cat',
      reason: 'Typo',
      instruction: 'make it more formal',
    };

    it('returns the revised fields on success', async () => {
      fetchStub.mockResolvedValue(new Response(
        JSON.stringify({ suggestion: { replacementText: 'the feline' } }),
        { status: 200 },
      ));
      expect(await service.refineSuggestion(payload)).toEqual({ replacementText: 'the feline' });
    });

    it('returns null on a non-ok response or thrown error', async () => {
      fetchStub.mockResolvedValue(new Response('nope', { status: 500 }));
      expect(await service.refineSuggestion(payload)).toBeNull();
      fetchStub.mockRejectedValue(new Error('down'));
      expect(await service.refineSuggestion(payload)).toBeNull();
    });
  });
});
