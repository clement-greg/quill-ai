import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { vi } from 'vitest';
import {
  ChapterEditProposal,
  ChatSessionMessage,
  EntityLinkSession,
} from '@shared/models';
import { QuickChatService } from './quick-chat.service';
import { EditorBridgeService } from './editor-bridge.service';
import { AiAssistantService } from './ai-assistant.service';
import { ChapterSyncService } from './chapter-sync.service';
import { EditorReviewService } from './editor-review.service';
import { AuthFetchService } from './auth-fetch.service';

function assistantMessage(overrides: Partial<ChatSessionMessage> = {}): ChatSessionMessage {
  return { role: 'assistant', text: 'Here is my answer.', ...overrides };
}

function makeProposal(overrides: Partial<ChapterEditProposal> = {}): ChapterEditProposal {
  return { kind: 'replace', anchorText: 'old prose', newText: 'new prose', explanation: 'tighter', ...overrides };
}

function makeLinkSession(overrides: Partial<EntityLinkSession> = {}): EntityLinkSession {
  return {
    entityId: 'ent-1',
    entityName: 'Mark',
    index: 0,
    groups: [
      { text: 'Mark', refType: 'first-name', count: 3 },
      { text: 'Captain Mark', refType: 'title-full-name', count: 1 },
    ],
    ...overrides,
  };
}

describe('QuickChatService', () => {
  let service: QuickChatService;
  let bridgeStub: Record<string, ReturnType<typeof vi.fn>>;
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    bridgeStub = {
      applyChapterEdit: vi.fn(() => true),
      clearEditPreview: vi.fn(),
      applyEntityTerm: vi.fn(),
      highlightEntityTerm: vi.fn(),
      clearEntityLinkHighlight: vi.fn(),
    };
    fetchStub = vi.fn(async () => new Response('{}', { status: 200 }));

    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: EditorBridgeService, useValue: bridgeStub },
        { provide: AiAssistantService, useValue: {} },
        { provide: ChapterSyncService, useValue: {} },
        { provide: EditorReviewService, useValue: {} },
        { provide: AuthFetchService, useValue: { fetch: fetchStub } },
      ],
    });
    service = TestBed.inject(QuickChatService);
  });

  describe('panel state', () => {
    it('starts minimized and toggles open/closed', () => {
      expect(service.minimized()).toBe(true);
      service.toggle();
      expect(service.minimized()).toBe(false);
      service.toggle();
      expect(service.minimized()).toBe(true);
    });

    it('reset clears the conversation and active session', () => {
      service.messages.set([assistantMessage()]);
      service.activeSessionId.set('sess-1');
      service.pinnedChapterId.set('ch-1');
      service.reset();
      expect(service.messages()).toEqual([]);
      expect(service.activeSessionId()).toBeNull();
      expect(service.pinnedChapterId()).toBeNull();
    });

    it('remembers the active session id in localStorage', () => {
      service.activeSessionId.set('sess-42');
      TestBed.tick();
      expect(localStorage.getItem('quill_last_chat_session_id')).toBe('sess-42');
      service.activeSessionId.set(null);
      TestBed.tick();
      expect(localStorage.getItem('quill_last_chat_session_id')).toBeNull();
    });
  });

  describe('edit proposals', () => {
    it('applies a proposal through the editor bridge and marks it applied', () => {
      service.messages.set([assistantMessage({ editProposal: makeProposal() })]);

      expect(service.applyEditProposal(0)).toBe(true);
      expect(bridgeStub['applyChapterEdit']).toHaveBeenCalledWith(expect.objectContaining({ anchorText: 'old prose' }));
      expect(bridgeStub['clearEditPreview']).toHaveBeenCalled();
      expect(service.messages()[0].editProposal?.applied).toBe(true);
    });

    it('does not re-apply an already-applied proposal', () => {
      service.messages.set([assistantMessage({ editProposal: makeProposal({ applied: true }) })]);
      expect(service.applyEditProposal(0)).toBe(false);
      expect(bridgeStub['applyChapterEdit']).not.toHaveBeenCalled();
    });

    it('leaves the proposal pending when the editor cannot locate the anchor', () => {
      bridgeStub['applyChapterEdit'].mockReturnValue(false);
      service.messages.set([assistantMessage({ editProposal: makeProposal() })]);
      expect(service.applyEditProposal(0)).toBe(false);
      expect(service.messages()[0].editProposal?.applied).toBeUndefined();
    });

    it('returns false for a message without a proposal', () => {
      service.messages.set([assistantMessage()]);
      expect(service.applyEditProposal(0)).toBe(false);
      expect(service.applyEditProposal(99)).toBe(false);
    });

    it('discard drops the proposal card and clears the editor preview', () => {
      service.messages.set([assistantMessage({ editProposal: makeProposal() })]);
      service.discardEditProposal(0);
      expect(bridgeStub['clearEditPreview']).toHaveBeenCalled();
      expect(service.messages()[0].editProposal).toBeUndefined();
      expect(service.messages()[0].text).toBe('Here is my answer.');
    });

    it('persists to the active session after applying', () => {
      service.messages.set([assistantMessage({ editProposal: makeProposal() })]);
      service.activeSessionId.set('sess-1');
      service.applyEditProposal(0);
      expect(fetchStub).toHaveBeenCalled();
    });
  });

  describe('entity link sessions', () => {
    beforeEach(() => {
      service.messages.set([assistantMessage({ linkSession: makeLinkSession() })]);
    });

    function session(): EntityLinkSession {
      return service.messages()[0].linkSession!;
    }

    it('linking applies the term, records the decision, and advances', () => {
      service.linkEntityGroup(0);
      expect(bridgeStub['applyEntityTerm']).toHaveBeenCalledWith('ent-1', 'Mark', 'first-name');
      expect(session().groups[0].status).toBe('linked');
      expect(session().index).toBe(1);
      // The next pending term is highlighted in the editor.
      expect(bridgeStub['highlightEntityTerm']).toHaveBeenCalledWith('Captain Mark');
    });

    it('skipping records the decision without touching the editor', () => {
      service.skipEntityGroup(0);
      expect(bridgeStub['applyEntityTerm']).not.toHaveBeenCalled();
      expect(session().groups[0].status).toBe('skipped');
      expect(session().index).toBe(1);
    });

    it('clears the highlight after the final decision', () => {
      service.linkEntityGroup(0);
      service.skipEntityGroup(0);
      expect(session().index).toBe(2);
      expect(session().groups.map(g => g.status)).toEqual(['linked', 'skipped']);
      expect(bridgeStub['clearEntityLinkHighlight']).toHaveBeenCalled();
    });

    it('ignores decisions once the session is exhausted', () => {
      service.linkEntityGroup(0);
      service.linkEntityGroup(0);
      service.linkEntityGroup(0); // one past the end
      expect(session().index).toBe(2);
      expect(bridgeStub['applyEntityTerm']).toHaveBeenCalledTimes(2);
    });

    it('stopLinkSession jumps to the end, leaving pending terms undecided', () => {
      service.stopLinkSession(0);
      expect(session().index).toBe(2);
      expect(session().groups.map(g => g.status)).toEqual([undefined, undefined]);
      expect(bridgeStub['clearEntityLinkHighlight']).toHaveBeenCalled();
    });
  });

  describe('highlights', () => {
    const highlight = { id: 'h-1', startOffset: 5, endOffset: 12, color: 'yellow' };

    it('adds a highlight to the addressed message', async () => {
      service.messages.set([assistantMessage(), assistantMessage({ text: 'Second.' })]);
      await service.addHighlight(1, highlight);
      expect(service.messages()[0].highlights).toBeUndefined();
      expect(service.messages()[1].highlights).toEqual([highlight]);
    });

    it('removes only highlights overlapping the given range', async () => {
      const before = { id: 'h-0', startOffset: 0, endOffset: 5, color: 'green' };
      const after = { id: 'h-2', startOffset: 12, endOffset: 20, color: 'blue' };
      service.messages.set([assistantMessage({ highlights: [before, highlight, after] })]);

      await service.removeHighlightsInRange(0, 6, 10); // overlaps only `highlight`
      expect(service.messages()[0].highlights).toEqual([before, after]);
    });

    it('ignores out-of-range message indexes', async () => {
      service.messages.set([assistantMessage()]);
      await service.addHighlight(5, highlight);
      expect(service.messages()[0].highlights).toBeUndefined();
    });
  });

  describe('loadSession', () => {
    it('loads messages and pins the chapter from a saved session', async () => {
      fetchStub.mockResolvedValue(
        new Response(JSON.stringify({ messages: [assistantMessage()], chapterId: 'ch-9' }), { status: 200 }),
      );
      await service.loadSession('sess-9');
      expect(service.messages()).toHaveLength(1);
      expect(service.activeSessionId()).toBe('sess-9');
      expect(service.pinnedChapterId()).toBe('ch-9');
      expect(service.minimized()).toBe(false);
    });

    it('stays minimized when restoring silently', async () => {
      fetchStub.mockResolvedValue(
        new Response(JSON.stringify({ messages: [] }), { status: 200 }),
      );
      await service.loadSession('sess-9', false);
      expect(service.minimized()).toBe(true);
    });

    it('leaves state untouched when the session cannot be fetched', async () => {
      fetchStub.mockResolvedValue(new Response('nope', { status: 404 }));
      await service.loadSession('sess-gone');
      expect(service.messages()).toEqual([]);
      expect(service.activeSessionId()).toBeNull();
    });
  });
});
