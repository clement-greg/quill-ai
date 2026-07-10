import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { ChatFolder, ChatSession, ChatSessionSummary } from '@shared/models';
import { AiAssistantService } from './ai-assistant.service';
import { SeriesContextService } from '@app/core/services/series-context.service';
import { AuthFetchService } from '@app/core/services/auth-fetch.service';

function summary(overrides: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return { id: 'sess-1', name: 'Chat', pinned: false, folderId: null, updatedAt: '2026-01-01T00:00:00Z', ...overrides };
}

function folder(overrides: Partial<ChatFolder> = {}): ChatFolder {
  return { id: 'f-1', name: 'Folder', parentFolderId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides };
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'sess-1',
    name: 'My Chat',
    pinned: false,
    folderId: null,
    seriesId: 's-1',
    messages: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** SSE body for the streaming chat endpoint. */
function sse(events: object[]): Response {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n`).join('') + 'data: [DONE]\n';
  return new Response(body, { status: 200 });
}

describe('AiAssistantService', () => {
  let service: AiAssistantService;
  let fetchStub: ReturnType<typeof vi.fn>;
  let contextSeriesId: ReturnType<typeof signal<string | null>>;

  beforeEach(() => {
    contextSeriesId = signal<string | null>(null);
    fetchStub = vi.fn(async () => json([]));
    TestBed.configureTestingModule({
      providers: [
        { provide: SeriesContextService, useValue: { currentSeriesId: contextSeriesId } },
        { provide: AuthFetchService, useValue: { fetch: fetchStub } },
      ],
    });
    service = TestBed.inject(AiAssistantService);
  });

  /** Returns the URLs fetched so far. */
  function fetchedUrls(): string[] {
    return fetchStub.mock.calls.map(c => c[0] as string);
  }

  describe('series selection', () => {
    it('setSeriesId resets state and loads sessions and folders for the new series', async () => {
      service.sessions.set([summary()]);
      service.activeSession.set(session());
      await service.setSeriesId('s-2');

      expect(service.selectedSeriesId()).toBe('s-2');
      expect(service.activeSession()).toBeNull();
      expect(fetchedUrls()).toContain('/api/chat-sessions?seriesId=s-2');
      expect(fetchedUrls()).toContain('/api/chat-folders?seriesId=s-2');
    });

    it('setSeriesId with the already-selected id is a no-op', async () => {
      await service.setSeriesId('s-2');
      fetchStub.mockClear();
      await service.setSeriesId('s-2');
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it('setSeriesId(null) clears state without fetching', async () => {
      await service.setSeriesId('s-2');
      fetchStub.mockClear();
      await service.setSeriesId(null);
      expect(service.selectedSeriesId()).toBeNull();
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it('autoDetectSeries selects the context series only when none is selected', async () => {
      service.autoDetectSeries('s-ctx');
      expect(service.selectedSeriesId()).toBe('s-ctx');
      service.autoDetectSeries('s-other');
      expect(service.selectedSeriesId()).toBe('s-ctx');
      service.autoDetectSeries(null);
      expect(service.selectedSeriesId()).toBe('s-ctx');
    });

    it('loadAllSeries keeps only active series, sorted by title, and auto-selects a sole series', async () => {
      fetchStub.mockImplementation(async (url: string) =>
        url === '/api/series'
          ? json([
              { id: 's-b', title: 'Beta' },
              { id: 's-arch', title: 'Old', archived: true },
              { id: 's-del', title: 'Gone', deleted: true },
            ])
          : json([]));
      await service.loadAllSeries();
      expect(service.allSeries().map(s => s.id)).toEqual(['s-b']);
      // Only one active series -> auto-selected.
      expect(service.selectedSeriesId()).toBe('s-b');
    });
  });

  describe('session lists', () => {
    it('pinnedSessions returns pinned chats newest first', () => {
      service.sessions.set([
        summary({ id: 'a', pinned: true, updatedAt: '2026-01-01T00:00:00Z' }),
        summary({ id: 'b', pinned: false }),
        summary({ id: 'c', pinned: true, updatedAt: '2026-02-01T00:00:00Z' }),
      ]);
      expect(service.pinnedSessions().map(s => s.id)).toEqual(['c', 'a']);
    });

    it('recentSessions excludes pinned and chapter-bound chats', () => {
      service.sessions.set([
        summary({ id: 'a', pinned: true }),
        summary({ id: 'b', chapterId: 'ch-1' }),
        summary({ id: 'c', updatedAt: '2026-01-02T00:00:00Z' }),
        summary({ id: 'd', updatedAt: '2026-03-01T00:00:00Z' }),
      ]);
      expect(service.recentSessions().map(s => s.id)).toEqual(['d', 'c']);
    });
  });

  describe('pending sessions', () => {
    it('startPendingSession shows an empty local chat flagged as pending', () => {
      service.startPendingSession('f-1');
      const active = service.activeSession()!;
      expect(service.isPendingSession()).toBe(true);
      expect(active.name).toBe('New Chat');
      expect(active.folderId).toBe('f-1');
      expect(active.messages).toEqual([]);
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it('deleting a pending session clears it locally without hitting the server', async () => {
      service.startPendingSession();
      await service.deleteSession(service.activeSession()!.id);
      expect(service.activeSession()).toBeNull();
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  describe('folders', () => {
    it('deleteFolder re-parents child folders and sessions to the deleted folder parent', async () => {
      service.folders.set([
        folder({ id: 'root' }),
        folder({ id: 'mid', parentFolderId: 'root' }),
        folder({ id: 'leaf', parentFolderId: 'mid' }),
      ]);
      service.sessions.set([
        summary({ id: 'in-mid', folderId: 'mid' }),
        summary({ id: 'elsewhere', folderId: 'root' }),
      ]);

      await service.deleteFolder('mid');

      expect(service.folders().map(f => f.id)).toEqual(['root', 'leaf']);
      expect(service.folders().find(f => f.id === 'leaf')?.parentFolderId).toBe('root');
      expect(service.sessions().find(s => s.id === 'in-mid')?.folderId).toBe('root');
      expect(service.sessions().find(s => s.id === 'elsewhere')?.folderId).toBe('root');
    });

    it('createFolder appends the created folder to the list', async () => {
      fetchStub.mockResolvedValue(json(folder({ id: 'f-new', name: 'Research' })));
      const created = await service.createFolder('Research', null);
      expect(created?.id).toBe('f-new');
      expect(service.folders().map(f => f.id)).toEqual(['f-new']);
    });

    it('createFolder returns null and leaves the list alone on failure', async () => {
      fetchStub.mockResolvedValue(new Response('nope', { status: 500 }));
      expect(await service.createFolder('Research', null)).toBeNull();
      expect(service.folders()).toEqual([]);
    });

    it('renameFolder updates only the target folder', async () => {
      service.folders.set([folder({ id: 'f-1', name: 'Old' }), folder({ id: 'f-2', name: 'Keep' })]);
      await service.renameFolder('f-1', 'New');
      expect(service.folders().map(f => f.name)).toEqual(['New', 'Keep']);
    });
  });

  describe('session mutations', () => {
    it('togglePin flips the pinned flag and persists it', async () => {
      service.sessions.set([summary({ id: 'sess-1', pinned: false })]);
      await service.togglePin('sess-1');
      expect(service.sessions()[0].pinned).toBe(true);
      const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/chat-sessions/sess-1');
      expect(JSON.parse(init.body as string)).toEqual({ pinned: true });
    });

    it('renameSession updates the list and the active session', async () => {
      service.sessions.set([summary({ id: 'sess-1', name: 'Old' })]);
      service.activeSession.set(session({ id: 'sess-1', name: 'Old' }));
      await service.renameSession('sess-1', 'Renamed');
      expect(service.sessions()[0].name).toBe('Renamed');
      expect(service.activeSession()?.name).toBe('Renamed');
    });

    it('deleteSession archives the session and closes it if active', async () => {
      service.sessions.set([summary({ id: 'sess-1' }), summary({ id: 'sess-2' })]);
      service.activeSession.set(session({ id: 'sess-1' }));
      await service.deleteSession('sess-1');
      expect(fetchedUrls()).toContain('/api/chat-sessions/sess-1/archive');
      expect(service.sessions().map(s => s.id)).toEqual(['sess-2']);
      expect(service.activeSession()).toBeNull();
    });
  });

  describe('sendMessage', () => {
    it('streams the assistant reply into the placeholder and persists the exchange', async () => {
      service.sessions.set([summary({ id: 'sess-1' })]);
      service.activeSession.set(session({ id: 'sess-1' }));
      fetchStub.mockImplementation(async (url: string) =>
        url === '/api/chat-sessions/sess-1/chat'
          ? sse([
              { content: 'Hello ' },
              { content: 'author.' },
              { sources: [{ n: 1, chapterId: 'ch-1', title: 'One' }] },
            ])
          : json({}));

      await service.sendMessage('Hi Quill');

      const messages = service.activeSession()!.messages;
      expect(messages.map(m => m.role)).toEqual(['user', 'assistant']);
      expect(messages[0].text).toBe('Hi Quill');
      expect(messages[1].text).toBe('Hello author.');
      expect(messages[1].sources?.length).toBe(1);
      expect(service.streaming()).toBe(false);
      // The completed exchange is persisted back to the session.
      const persist = fetchStub.mock.calls.find(
        c => c[0] === '/api/chat-sessions/sess-1' && (c[1] as RequestInit)?.method === 'PUT');
      expect(persist).toBeTruthy();
    });

    it('processes a final data line that arrives without a trailing newline', async () => {
      service.sessions.set([summary({ id: 'sess-1' })]);
      service.activeSession.set(session({ id: 'sess-1' }));
      const body = `data: ${JSON.stringify({ content: 'Hello ' })}\ndata: ${JSON.stringify({ content: 'author.' })}`;
      fetchStub.mockImplementation(async (url: string) =>
        url === '/api/chat-sessions/sess-1/chat' ? new Response(body, { status: 200 }) : json({}));

      await service.sendMessage('Hi Quill');

      expect(service.activeSession()!.messages.at(-1)!.text).toBe('Hello author.');
    });

    it('materialises a pending session before sending the first message', async () => {
      service.startPendingSession();
      fetchStub.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === '/api/chat-sessions' && init?.method === 'POST') {
          return json(session({ id: 'sess-new', name: 'My Chat' }));
        }
        if (url === '/api/chat-sessions/sess-new/chat') {
          return sse([{ content: 'Answer.' }]);
        }
        return json({});
      });

      await service.sendMessage('First message');

      expect(service.activeSession()?.id).toBe('sess-new');
      expect(service.isPendingSession()).toBe(false);
      expect(service.sessions().some(s => s.id === 'sess-new')).toBe(true);
      expect(service.activeSession()?.messages[1].text).toBe('Answer.');
    });

    it('writes an error into the assistant message when the stream cannot start', async () => {
      service.activeSession.set(session({ id: 'sess-1' }));
      fetchStub.mockImplementation(async (url: string) =>
        url === '/api/chat-sessions/sess-1/chat' ? new Response('nope', { status: 500 }) : json({}));

      await service.sendMessage('Hi');

      const last = service.activeSession()!.messages.at(-1)!;
      expect(last.role).toBe('assistant');
      expect(last.text).toBe('Error: failed to get a response.');
      expect(service.streaming()).toBe(false);
    });

    it('surfaces streamed error events in the assistant message', async () => {
      service.activeSession.set(session({ id: 'sess-1' }));
      fetchStub.mockImplementation(async (url: string) =>
        url === '/api/chat-sessions/sess-1/chat' ? sse([{ error: 'Overloaded' }]) : json({}));

      await service.sendMessage('Hi');
      expect(service.activeSession()!.messages.at(-1)!.text).toBe('Error: Overloaded');
    });

    it('does nothing without an active session', async () => {
      await service.sendMessage('Hi');
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  describe('highlights', () => {
    const highlight = { id: 'h-1', startOffset: 2, endOffset: 6, color: 'yellow' };

    beforeEach(() => {
      service.activeSession.set(session({
        id: 'sess-1',
        messages: [
          { role: 'user', text: 'Question' },
          { role: 'assistant', text: 'A long answer.' },
        ],
      }));
    });

    it('addHighlight attaches to the addressed message and persists', async () => {
      await service.addHighlight(1, highlight);
      const messages = service.activeSession()!.messages;
      expect(messages[0].highlights).toBeUndefined();
      expect(messages[1].highlights).toEqual([highlight]);
      expect(fetchStub).toHaveBeenCalled();
    });

    it('removeHighlightsInRange drops only overlapping highlights', async () => {
      const before = { id: 'h-0', startOffset: 0, endOffset: 2, color: 'green' };
      const after = { id: 'h-2', startOffset: 8, endOffset: 12, color: 'blue' };
      await service.addHighlight(1, before);
      await service.addHighlight(1, highlight);
      await service.addHighlight(1, after);

      await service.removeHighlightsInRange(1, 3, 5); // overlaps only `highlight`
      expect(service.activeSession()!.messages[1].highlights).toEqual([before, after]);
    });

    it('removeHighlight deletes by id', async () => {
      await service.addHighlight(1, highlight);
      await service.removeHighlight(1, 'h-1');
      expect(service.activeSession()!.messages[1].highlights).toEqual([]);
    });
  });

  describe('panel open behaviour', () => {
    it('togglePanel opens and closes', () => {
      expect(service.isOpen()).toBe(false);
      service.togglePanel();
      expect(service.isOpen()).toBe(true);
      service.closePanel();
      expect(service.isOpen()).toBe(false);
    });

    it('opening the panel loads series then adopts the context series', async () => {
      contextSeriesId.set('s-ctx');
      fetchStub.mockImplementation(async (url: string) =>
        url === '/api/series'
          ? json([{ id: 's-ctx', title: 'Context' }, { id: 's-other', title: 'Other' }])
          : json([]));

      service.openPanel();
      await vi.waitFor(() => expect(service.selectedSeriesId()).toBe('s-ctx'));
      expect(fetchedUrls()).toContain('/api/chat-sessions?seriesId=s-ctx');
    });
  });
});
