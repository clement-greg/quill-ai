import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { FactCheckFinding } from '@shared/models/fact-check.model';
import { FactCheckService } from './fact-check.service';
import { AuthFetchService } from '@app/core/services/auth-fetch.service';

function makeFinding(overrides: Partial<FactCheckFinding> = {}): FactCheckFinding {
  return {
    id: 'f-1',
    claim: 'The Titanic sank in 1912.',
    category: 'history',
    verdict: 'verified',
    confidence: 90,
    explanation: 'It did.',
    grounded: false,
    ...overrides,
  };
}

/** Builds an SSE Response streaming one `data:` line per event. */
function sseResponse(events: object[]): Response {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n`).join('') + 'data: [DONE]\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('FactCheckService', () => {
  let service: FactCheckService;
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchStub = vi.fn(async () => sseResponse([]));
    TestBed.configureTestingModule({
      providers: [{ provide: AuthFetchService, useValue: { fetch: fetchStub } }],
    });
    service = TestBed.inject(FactCheckService);
  });

  describe('run', () => {
    it('posts the chapter text with entity names and finishes in the done stage', async () => {
      await service.run('Some prose.', ['Elowen']);

      expect(fetchStub).toHaveBeenCalledTimes(1);
      const [url, init] = fetchStub.mock.calls[0];
      expect(url).toBe('/api/fact-check');
      expect(JSON.parse(init.body as string))
        .toEqual({ text: 'Some prose.', knownEntityNames: ['Elowen'] });
      expect(service.stage()).toBe('done');
      expect(service.running()).toBe(false);
    });

    it('tracks the run totals and collects streamed findings', async () => {
      fetchStub.mockResolvedValueOnce(sseResponse([
        { stage: 'extracting' },
        { stage: 'checking', total: 2, truncated: true, searchAvailable: true },
        { finding: makeFinding({ id: 'a', grounded: true }) },
        { finding: makeFinding({ id: 'b' }) },
      ]));

      await service.run('Some prose.');

      expect(service.total()).toBe(2);
      expect(service.truncated()).toBe(true);
      expect(service.searchAvailable()).toBe(true);
      expect(service.completed()).toBe(2);
      expect(service.groundedCount()).toBe(1);
      expect(service.percentComplete()).toBe(100);
      expect(service.findings().map(f => f.id)).toEqual(['a', 'b']);
    });

    it('sorts findings for display: disputed, then unverifiable, then verified', async () => {
      fetchStub.mockResolvedValueOnce(sseResponse([
        { stage: 'checking', total: 4, truncated: false, searchAvailable: true },
        { finding: makeFinding({ id: 'verified-high', verdict: 'verified', confidence: 99 }) },
        { finding: makeFinding({ id: 'unverifiable', verdict: 'unverifiable', confidence: 30 }) },
        { finding: makeFinding({ id: 'disputed-low', verdict: 'disputed', confidence: 55 }) },
        { finding: makeFinding({ id: 'disputed-high', verdict: 'disputed', confidence: 95 }) },
      ]));

      await service.run('Some prose.');

      expect(service.sortedFindings().map(f => f.id))
        .toEqual(['disputed-high', 'disputed-low', 'unverifiable', 'verified-high']);
      // Arrival order is preserved in the raw list.
      expect(service.findings()[0].id).toBe('verified-high');
    });

    it('reports partial progress while the run is still streaming', async () => {
      fetchStub.mockResolvedValueOnce(sseResponse([
        { stage: 'checking', total: 4, truncated: false, searchAvailable: true },
        { finding: makeFinding({ id: 'a' }) },
      ]));

      await service.run('Some prose.');
      expect(service.percentComplete()).toBe(25);
    });

    it('surfaces a streamed error', async () => {
      fetchStub.mockResolvedValueOnce(sseResponse([{ error: 'The fact check failed.' }]));
      await service.run('Some prose.');
      expect(service.error()).toBe('The fact check failed.');
    });

    it('surfaces a failed request', async () => {
      fetchStub.mockResolvedValueOnce(new Response('nope', { status: 500 }));
      await service.run('Some prose.');
      expect(service.error()).toBe('The fact check could not be started.');
    });

    it('surfaces a connection failure', async () => {
      fetchStub.mockRejectedValueOnce(new Error('offline'));
      await service.run('Some prose.');
      expect(service.error()).toBe('Could not reach the fact checker.');
    });

    it('ignores a second run while one is in flight', async () => {
      let release!: (res: Response) => void;
      fetchStub.mockReturnValueOnce(new Promise<Response>(resolve => { release = resolve; }));

      const first = service.run('Some prose.');
      expect(service.running()).toBe(true);
      await service.run('Other prose.');
      expect(fetchStub).toHaveBeenCalledTimes(1);

      release(sseResponse([]));
      await first;
    });

    it('clears the previous report when a new run starts', async () => {
      fetchStub.mockResolvedValueOnce(sseResponse([
        { stage: 'checking', total: 1, truncated: true, searchAvailable: true },
        { finding: makeFinding({ id: 'old' }) },
      ]));
      await service.run('Some prose.');

      fetchStub.mockResolvedValueOnce(sseResponse([]));
      await service.run('New prose.');

      expect(service.findings()).toEqual([]);
      expect(service.total()).toBe(0);
      expect(service.truncated()).toBe(false);
      expect(service.stopped()).toBe(false);
    });
  });

  describe('stop', () => {
    it('aborts the request, keeps what arrived, and flags the run as stopped', async () => {
      let release!: (res: Response) => void;
      let signal: AbortSignal | undefined;
      fetchStub.mockImplementationOnce((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(resolve => { release = resolve; });
      });

      const run = service.run('Some prose.');
      service.findings.set([makeFinding({ id: 'partial' })]);
      service.stop();

      expect(signal?.aborted).toBe(true);
      expect(service.stopped()).toBe(true);
      expect(service.running()).toBe(false);
      expect(service.findings().map(f => f.id)).toEqual(['partial']);

      release(sseResponse([]));
      await run;
    });

    it('does nothing when no run is in flight', () => {
      service.stop();
      expect(service.stopped()).toBe(false);
      expect(service.stage()).toBe('idle');
    });
  });

  describe('reset', () => {
    it('clears the report and returns to idle', async () => {
      fetchStub.mockResolvedValueOnce(sseResponse([
        { stage: 'checking', total: 1, truncated: false, searchAvailable: true },
        { finding: makeFinding() },
      ]));
      await service.run('Some prose.');

      service.reset();

      expect(service.stage()).toBe('idle');
      expect(service.findings()).toEqual([]);
      expect(service.error()).toBeNull();
      expect(service.searchAvailable()).toBe(false);
    });
  });
});
