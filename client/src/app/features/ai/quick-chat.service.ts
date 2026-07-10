import { Injectable, inject, signal, effect } from '@angular/core';
import { Router } from '@angular/router';
import { ChapterCitation, ChapterEditProposal, ChatMessageHighlight, ChatSession, ChatSessionMessage, ChatSessionSummary, EntityLinkSession, MapPreview } from '@shared/models';
import { EditorBridgeService } from '@app/features/chapters/editor-bridge.service';
import { AiAssistantService } from './ai-assistant.service';
import { ChapterSyncService, ChapterExternalUpdate } from '@app/features/chapters/chapter-sync.service';
import { EditorReviewService } from '@app/features/chapters/editor-review.service';
import { AuthFetchService } from '@app/core/services/auth-fetch.service';

/** Remembers the last active session so a page refresh reopens it. */
const LAST_SESSION_KEY = 'quill_last_chat_session_id';


/**
 * Backs the "Ask Quill" overlay. Every conversation is auto-saved into a
 * global "Chats" folder in the Resource Manager (no series required); the user
 * can move sessions from there to any folder they like.
 */
@Injectable({ providedIn: 'root' })
export class QuickChatService {
  private readonly router = inject(Router);
  private readonly editorBridge = inject(EditorBridgeService);
  private readonly aiAssistant = inject(AiAssistantService);
  private readonly chapterSync = inject(ChapterSyncService);
  private readonly editorReview = inject(EditorReviewService);
  private readonly authFetchService = inject(AuthFetchService);

  /** The panel is always present — it cannot be fully closed, only minimized. */
  readonly isOpen = signal(true);
  /** Starts collapsed so it's non-intrusive on load; user expands on demand. */
  readonly minimized = signal(true);
  readonly messages = signal<ChatSessionMessage[]>([]);
  readonly streaming = signal(false);
  /** Set when a saved session is loaded; new messages are auto-persisted to it. */
  readonly activeSessionId = signal<string | null>(null);
  /** The chapter this session is pinned to, if any. */
  readonly pinnedChapterId = signal<string | null>(null);

  private abortController: AbortController | null = null;
  /** Cached ID of the global "Chats" folder so we don't re-query on every message. */
  private chatsFolderId: string | null = null;

  constructor() {
    // Restore the last active conversation on load, but leave the panel
    // minimized so the refresh isn't intrusive — the user expands on demand.
    const lastId = localStorage.getItem(LAST_SESSION_KEY);
    if (lastId) void this.loadSession(lastId, false);

    // Persist the active session id so the next refresh can reopen it.
    effect(() => {
      const id = this.activeSessionId();
      if (id) localStorage.setItem(LAST_SESSION_KEY, id);
      else localStorage.removeItem(LAST_SESSION_KEY);
    });
  }

  open(): void {
    this.minimized.set(false);
  }

  /** Collapses to the minimized bar — the panel is never fully closed. */
  close(): void {
    this.minimized.set(true);
  }

  minimize(): void {
    this.minimized.set(true);
  }

  restore(): void {
    this.minimized.set(false);
  }

  /** Ctrl/Cmd+I: expand if minimized, otherwise collapse. */
  toggle(): void {
    this.minimized.update(m => !m);
  }

  /** Clears the conversation (e.g. after saving or via "New chat"). */
  reset(): void {
    this.cancelStreaming();
    this.messages.set([]);
    this.activeSessionId.set(null);
    this.pinnedChapterId.set(null);
  }

  /** Loads a saved chat session into the panel. Subsequent messages are
   *  auto-persisted back to the same session. Expands the panel unless
   *  `expand` is false (e.g. when silently restoring on page load). */
  async loadSession(id: string, expand = true): Promise<void> {
    try {
      const res = await this.authFetch(`/api/chat-sessions/${id}`);
      if (res.ok) {
        const session = await res.json() as ChatSession;
        this.messages.set(session.messages);
        this.activeSessionId.set(id);
        this.pinnedChapterId.set(session.chapterId ?? null);
        if (expand) this.minimized.set(false);
      }
    } catch {
      // Best-effort
    }
  }

  async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.streaming()) return;

    // Ensure a session exists before we start streaming so every exchange is saved.
    await this.createAutoSaveSession();

    const now = new Date().toISOString();
    const userMsg: ChatSessionMessage = { role: 'user', text: trimmed, timestamp: now };
    const assistantPlaceholder: ChatSessionMessage = { role: 'assistant', text: '', timestamp: now };
    this.messages.update(list => [...list, userMsg, assistantPlaceholder]);
    this.streaming.set(true);

    // Keep context lean: last 3 prior exchanges (6 messages) + current = 7 max.
    const apiMessages = this.messages()
      .filter(m => m.text)
      .slice(-7)
      .map(m => ({ role: m.role, content: m.text }));

    // When opened from a chapter editor, ground the answer in that chapter and
    // the text surrounding the cursor (so it's suitable to insert there).
    const captured = this.editorBridge.captureContext();
    const chapterContext = captured
      ? {
          chapterId: captured.chapterId,
          surroundingText: captured.surroundingText,
          selectedText: captured.selectedText,
          outline: captured.outline,
          notes: captured.notes,
        }
      : undefined;

    this.abortController = new AbortController();

    try {
      const res = await this.authFetch('/api/chat-sessions/quick-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages, ...(chapterContext ? { chapterContext } : {}) }),
        signal: this.abortController.signal,
      });

      if (!res.ok || !res.body) {
        this.updateLastAssistantMessage('Error: failed to get a response.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as {
              content?: string;
              error?: string;
              sources?: ChapterCitation[];
              navigate?: { target: 'chapter' | 'book' | 'series' | 'entity'; id: string; title: string };
              runEditor?: boolean;
              map?: MapPreview;
              generatingImage?: boolean;
              image?: { url: string; thumbnailUrl: string; prompt?: string };
              imageError?: boolean;
              chapterUpdated?: ChapterExternalUpdate;
              chapterDraft?: boolean;
              beats?: string;
              lottie?: string;
              linkEntityReferences?: { entityId: string; entityName: string; terms: { text: string; refType: string }[] };
              proposeChapterEdit?: ChapterEditProposal;
              tool?: string;
            };
            if (parsed.error) {
              this.updateLastAssistantMessage(`Error: ${parsed.error}`);
            } else if (parsed.tool) {
              this.addToolUsedToLastAssistantMessage(parsed.tool);
            } else if (parsed.chapterDraft) {
              this.markLastAssistantAsDraft();
            } else if (parsed.beats) {
              this.setLastAssistantBeats(parsed.beats);
            } else if (parsed.navigate) {
              // The assistant invoked a navigation tool. Show a confirmation
              // message in the bubble (so it's never blank), navigate, and
              // leave the panel open so the user can continue the conversation.
              // When the editor tool requested an editorial pass, ask the editor
              // to auto-run once the chapter loads (it's a different component
              // instantiated by the navigation below).
              if (parsed.runEditor && parsed.navigate.target === 'chapter') {
                this.editorReview.requestAutoRun(parsed.navigate.id);
                this.updateLastAssistantMessage(`Opening "${parsed.navigate.title}" and running the Quill Editor…`);
              } else {
                this.updateLastAssistantMessage(`Opening "${parsed.navigate.title}"…`);
              }
              this.router.navigate(this.routeFor(parsed.navigate.target, parsed.navigate.id));
              return;
            } else if (parsed.map) {
              // The assistant surfaced a map: attach it to the message so it
              // renders inline as a clickable thumbnail (overlay stays open).
              this.addMapToLastAssistantMessage(parsed.map);
            } else if (parsed.generatingImage) {
              this.setLastAssistantGenerating(true);
            } else if (parsed.image) {
              this.setLastAssistantImage(parsed.image.url, parsed.image.thumbnailUrl);
            } else if (parsed.imageError) {
              this.setLastAssistantGenerating(false);
            } else if (parsed.lottie) {
              this.setLastAssistantLottie(parsed.lottie);
            } else if (parsed.chapterUpdated) {
              this.chapterSync.notify(parsed.chapterUpdated);
            } else if (parsed.linkEntityReferences) {
              // The assistant resolved an entity; scan the live chapter for plain
              // text matches and, if any, attach a step-through link session to
              // this message so the author confirms each unique match in the chat.
              const { entityId, entityName, terms } = parsed.linkEntityReferences;
              const groups = this.editorBridge.scanEntityLinks(terms);
              if (groups.length === 0) {
                this.updateLastAssistantMessage(`I couldn't find any unlinked plain-text references to ${entityName} in this chapter.`);
              } else {
                const total = groups.reduce((n, g) => n + g.count, 0);
                this.updateLastAssistantMessage(
                  `I found ${total} plain-text mention${total === 1 ? '' : 's'} of ${entityName} across ` +
                  `${groups.length} form${groups.length === 1 ? '' : 's'}. Link them?`,
                );
                this.setLastAssistantLinkSession({ entityId, entityName, groups, index: 0 });
                this.editorBridge.highlightEntityTerm(groups[0]!.text);
              }
              return;
            } else if (parsed.proposeChapterEdit) {
              // The assistant proposed a targeted edit. Attach it to the message
              // (renders a before→after card) and highlight the spot in the live
              // editor. The assistant's short confirmation text streams after this.
              this.setLastAssistantEditProposal(parsed.proposeChapterEdit);
              this.editorBridge.previewChapterEdit(parsed.proposeChapterEdit);
            } else if (parsed.content) {
              this.appendToLastAssistantMessage(parsed.content);
            } else if (parsed.sources) {
              this.setLastAssistantSources(parsed.sources);
            }
          } catch {
            // Skip malformed SSE chunk
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        this.updateLastAssistantMessage('Error: could not connect to AI.');
      }
    } finally {
      this.streaming.set(false);
      this.abortController = null;
      const sessionId = this.activeSessionId();
      if (sessionId) {
        void this.persistToSession(sessionId);
        // Name the session from the first exchange only (exactly 1 user + 1 assistant message with text).
        if (this.messages().filter(m => m.text).length === 2) {
          void this.nameSession(sessionId).then(() => void this.aiAssistant.loadSessions());
        }
      }
    }
  }

  /** Finds or creates the global "Chats" folder (no series). Result is cached. */
  private async getOrCreateChatsFolder(): Promise<string | null> {
    if (this.chatsFolderId) return this.chatsFolderId;
    try {
      const res = await this.authFetch('/api/chat-folders');
      if (res.ok) {
        const folders = await res.json() as Array<{ id: string; name: string; seriesId?: string | null }>;
        const existing = folders.find(f => f.name.toLowerCase() === 'chats' && !f.seriesId);
        if (existing) { this.chatsFolderId = existing.id; return existing.id; }
      }
      const createRes = await this.authFetch('/api/chat-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Chats', seriesId: null }),
      });
      if (createRes.ok) {
        const folder = await createRes.json() as { id: string };
        this.chatsFolderId = folder.id;
        return folder.id;
      }
    } catch {
      // Best-effort
    }
    return null;
  }

  /** Creates a session in the Chats folder if one isn't already active. */
  private async createAutoSaveSession(): Promise<void> {
    if (this.activeSessionId()) return;
    try {
      const folderId = await this.getOrCreateChatsFolder();
      const res = await this.authFetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, seriesId: null }),
      });
      if (res.ok) {
        const session = await res.json() as ChatSession;
        this.activeSessionId.set(session.id);
        void this.aiAssistant.loadFolders();
        void this.aiAssistant.loadSessions();
      }
    } catch {
      // Best-effort — conversation continues even if session creation fails
    }
  }

  /** Generates a name for the session from the first exchange. */
  private async nameSession(sessionId: string): Promise<void> {
    try {
      const messages = this.messages()
        .filter(m => m.text)
        .slice(0, 2)
        .map(m => ({ role: m.role, content: m.text }));
      await this.authFetch(`/api/chat-sessions/${sessionId}/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
    } catch {
      // Best-effort
    }
  }

  private async persistToSession(sessionId: string): Promise<void> {
    const messages = this.messages()
      .filter(m => m.text || m.imageUrl)
      .map(({ role, text, imageUrl, thumbnailUrl, sources, kind, beats, lottieUrl, editProposal, linkSession, toolsUsed }) => ({
        role, text,
        ...(imageUrl ? { imageUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(sources?.length ? { sources } : {}),
        ...(kind ? { kind } : {}),
        ...(beats ? { beats } : {}),
        ...(lottieUrl ? { lottieUrl } : {}),
        ...(editProposal ? { editProposal } : {}),
        ...(linkSession ? { linkSession } : {}),
        ...(toolsUsed?.length ? { toolsUsed } : {}),
      }));
    try {
      await this.authFetch(`/api/chat-sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
    } catch {
      // Best-effort
    }
  }

  /** Pins the active session to the given chapter. No-op if no session is active. */
  async pinToChapter(chapterId: string): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId) return;
    try {
      const res = await this.authFetch(`/api/chat-sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterId }),
      });
      if (res.ok) {
        this.pinnedChapterId.set(chapterId);
        void this.aiAssistant.loadSessions();
      }
    } catch {
      // Best-effort
    }
  }

  /** Removes the chapter association from the active session. */
  async unpinFromChapter(): Promise<void> {
    const sessionId = this.activeSessionId();
    if (!sessionId) return;
    await this.unpinSession(sessionId);
  }

  /** Removes the chapter association from any session (active or not). */
  async unpinSession(sessionId: string): Promise<void> {
    try {
      const res = await this.authFetch(`/api/chat-sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterId: null }),
      });
      if (res.ok) {
        if (this.activeSessionId() === sessionId) this.pinnedChapterId.set(null);
        void this.aiAssistant.loadSessions();
      }
    } catch {
      // Best-effort
    }
  }

  /** Creates a new session pre-linked to a chapter, opens the panel, and focuses it. */
  async startLinkedChat(chapterId: string): Promise<void> {
    this.reset();
    try {
      const folderId = await this.getOrCreateChatsFolder();
      const res = await this.authFetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, seriesId: null, chapterId }),
      });
      if (res.ok) {
        const session = await res.json() as ChatSession;
        this.activeSessionId.set(session.id);
        this.pinnedChapterId.set(chapterId);
        void this.aiAssistant.loadFolders();
        void this.aiAssistant.loadSessions();
      }
    } catch {
      // Best-effort
    }
    this.minimized.set(false);
  }

  /** Returns sessions pinned to the given chapter. */
  async getLinkedChats(chapterId: string): Promise<ChatSessionSummary[]> {
    try {
      const res = await this.authFetch(`/api/chat-sessions/by-chapter/${chapterId}`);
      if (res.ok) return await res.json() as ChatSessionSummary[];
    } catch {
      // Best-effort
    }
    return [];
  }

  cancelStreaming(): void {
    this.abortController?.abort();
  }

  /** Maps a navigation tool target to its Angular router commands. */
  private routeFor(target: 'chapter' | 'book' | 'series' | 'entity', id: string): unknown[] {
    switch (target) {
      case 'chapter': return ['/chapters', id, 'edit'];
      case 'book': return ['/books', id];
      case 'series': return ['/series', id];
      case 'entity': return ['/entities', id];
    }
  }



  private updateLastAssistantMessage(text: string): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], text };
      return copy;
    });
  }

  private appendToLastAssistantMessage(delta: string): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, text: last.text + delta };
      return copy;
    });
  }

  private addMapToLastAssistantMessage(map: MapPreview): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      const last = copy[copy.length - 1];
      // Ignore a duplicate (same map streamed twice in one turn).
      if (last.maps?.some(m => m.id === map.id)) return msgs;
      copy[copy.length - 1] = { ...last, maps: [...(last.maps ?? []), map] };
      return copy;
    });
  }

  private setLastAssistantGenerating(generating: boolean): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], generatingImage: generating };
      return copy;
    });
  }

  /** Attaches a generated image to the last assistant message, keeping any
   * streamed caption text and clearing the generating flag. */
  private setLastAssistantImage(imageUrl: string, thumbnailUrl: string): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], imageUrl, thumbnailUrl, generatingImage: false };
      return copy;
    });
  }

  async addHighlight(messageIndex: number, highlight: ChatMessageHighlight): Promise<void> {
    this.messages.update(msgs => {
      const copy = [...msgs];
      const msg = copy[messageIndex];
      if (!msg) return msgs;
      copy[messageIndex] = { ...msg, highlights: [...(msg.highlights ?? []), highlight] };
      return copy;
    });
    const sessionId = this.activeSessionId();
    if (sessionId) void this.persistToSession(sessionId);
  }

  async removeHighlightsInRange(messageIndex: number, startOffset: number, endOffset: number): Promise<void> {
    this.messages.update(msgs => {
      const copy = [...msgs];
      const msg = copy[messageIndex];
      if (!msg || !msg.highlights?.length) return msgs;
      const filtered = msg.highlights.filter(
        h => h.endOffset <= startOffset || h.startOffset >= endOffset,
      );
      copy[messageIndex] = { ...msg, highlights: filtered };
      return copy;
    });
    const sessionId = this.activeSessionId();
    if (sessionId) void this.persistToSession(sessionId);
  }

  /** Uploads an image file into a Resource Manager folder. Returns true on success. */
  async uploadImageToFolder(folderId: string, file: File): Promise<boolean> {
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await this.authFetch(`/api/folder-files/${folderId}`, { method: 'POST', body: form });
      return res.ok;
    } catch {
      return false;
    }
  }

  private markLastAssistantAsDraft(): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], kind: 'chapter-draft' };
      return copy;
    });
  }

  /** Records a tool the assistant invoked for the in-progress message, preserving
   *  call order and ignoring duplicates. */
  private addToolUsedToLastAssistantMessage(tool: string): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      const last = copy[copy.length - 1];
      const existing = last.toolsUsed ?? [];
      if (existing.includes(tool)) return msgs;
      copy[copy.length - 1] = { ...last, toolsUsed: [...existing, tool] };
      return copy;
    });
  }

  private setLastAssistantLottie(lottieUrl: string): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], lottieUrl };
      return copy;
    });
  }

  private setLastAssistantBeats(beats: string): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], beats };
      return copy;
    });
  }

  private setLastAssistantEditProposal(editProposal: ChapterEditProposal): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], editProposal };
      return copy;
    });
  }

  /** Applies a proposed edit into the live editor and marks it applied. Returns
   *  false when the editor can no longer locate the anchor text. */
  applyEditProposal(messageIndex: number): boolean {
    const proposal = this.messages()[messageIndex]?.editProposal;
    if (!proposal || proposal.applied) return false;
    const applied = this.editorBridge.applyChapterEdit(proposal);
    if (!applied) return false;
    this.markEditProposalApplied(messageIndex);
    const sessionId = this.activeSessionId();
    if (sessionId) void this.persistToSession(sessionId);
    return true;
  }

  /** Discards a proposed edit: clears the editor preview and drops the card. */
  discardEditProposal(messageIndex: number): void {
    this.editorBridge.clearEditPreview();
    this.messages.update(msgs => {
      const copy = [...msgs];
      const msg = copy[messageIndex];
      if (!msg?.editProposal) return msgs;
      const { editProposal: _drop, ...rest } = msg;
      copy[messageIndex] = rest;
      return copy;
    });
    const sessionId = this.activeSessionId();
    if (sessionId) void this.persistToSession(sessionId);
  }

  private markEditProposalApplied(messageIndex: number): void {
    this.editorBridge.clearEditPreview();
    this.messages.update(msgs => {
      const copy = [...msgs];
      const msg = copy[messageIndex];
      if (!msg?.editProposal) return msgs;
      copy[messageIndex] = { ...msg, editProposal: { ...msg.editProposal, applied: true } };
      return copy;
    });
  }

  // ── Entity-link session (in-chat "link references" stepper) ──────────────
  private setLastAssistantLinkSession(linkSession: EntityLinkSession): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], linkSession };
      return copy;
    });
  }

  /** Links every occurrence of the current term, then advances to the next. */
  linkEntityGroup(messageIndex: number): void {
    this.advanceLinkSession(messageIndex, 'linked');
  }

  /** Leaves the current term as plain prose and advances to the next. */
  skipEntityGroup(messageIndex: number): void {
    this.advanceLinkSession(messageIndex, 'skipped');
  }

  /** Ends the session early, leaving any not-yet-reviewed terms untouched. */
  stopLinkSession(messageIndex: number): void {
    const session = this.messages()[messageIndex]?.linkSession;
    if (!session) return;
    this.editorBridge.clearEntityLinkHighlight();
    this.messages.update(msgs => {
      const copy = [...msgs];
      const msg = copy[messageIndex];
      if (!msg?.linkSession) return msgs;
      copy[messageIndex] = { ...msg, linkSession: { ...session, index: session.groups.length } };
      return copy;
    });
    const sessionId = this.activeSessionId();
    if (sessionId) void this.persistToSession(sessionId);
  }

  private advanceLinkSession(messageIndex: number, action: 'linked' | 'skipped'): void {
    const session = this.messages()[messageIndex]?.linkSession;
    if (!session || session.index >= session.groups.length) return;
    const group = session.groups[session.index]!;
    if (action === 'linked') this.editorBridge.applyEntityTerm(session.entityId, group.text, group.refType);

    const groups = session.groups.map((g, i) => i === session.index ? { ...g, status: action } : g);
    const nextIndex = session.index + 1;
    this.messages.update(msgs => {
      const copy = [...msgs];
      const msg = copy[messageIndex];
      if (!msg?.linkSession) return msgs;
      copy[messageIndex] = { ...msg, linkSession: { ...session, groups, index: nextIndex } };
      return copy;
    });

    if (nextIndex < groups.length) this.editorBridge.highlightEntityTerm(groups[nextIndex]!.text);
    else this.editorBridge.clearEntityLinkHighlight();

    const sessionId = this.activeSessionId();
    if (sessionId) void this.persistToSession(sessionId);
  }

  private setLastAssistantSources(sources: ChapterCitation[]): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], sources };
      return copy;
    });
  }

  private authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    return this.authFetchService.fetch(input, init);
  }
}
