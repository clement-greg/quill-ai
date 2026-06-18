import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ChapterCitation, ChatMessageHighlight, ChatSession, ChatSessionMessage, MapPreview } from '@shared/models';
import { EditorBridgeService } from './editor-bridge.service';
import { AiAssistantService } from './ai-assistant.service';
import { ChapterSyncService, ChapterExternalUpdate } from './chapter-sync.service';


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

  /** The panel is always present — it cannot be fully closed, only minimized. */
  readonly isOpen = signal(true);
  /** Starts collapsed so it's non-intrusive on load; user expands on demand. */
  readonly minimized = signal(true);
  readonly messages = signal<ChatSessionMessage[]>([]);
  readonly streaming = signal(false);
  /** Set when a saved session is loaded; new messages are auto-persisted to it. */
  readonly activeSessionId = signal<string | null>(null);

  private abortController: AbortController | null = null;
  /** Cached ID of the global "Chats" folder so we don't re-query on every message. */
  private chatsFolderId: string | null = null;

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
  }

  /** Loads a saved chat session into the panel and expands it.
   *  Subsequent messages are auto-persisted back to the same session. */
  async loadSession(id: string): Promise<void> {
    try {
      const res = await this.authFetch(`/api/chat-sessions/${id}`);
      if (res.ok) {
        const session = await res.json() as ChatSession;
        this.messages.set(session.messages);
        this.activeSessionId.set(id);
        this.minimized.set(false);
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

    const userMsg: ChatSessionMessage = { role: 'user', text: trimmed };
    const assistantPlaceholder: ChatSessionMessage = { role: 'assistant', text: '' };
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
              map?: MapPreview;
              generatingImage?: boolean;
              image?: { url: string; thumbnailUrl: string; prompt?: string };
              imageError?: boolean;
              chapterUpdated?: ChapterExternalUpdate;
              chapterDraft?: boolean;
              beats?: string;
            };
            if (parsed.error) {
              this.updateLastAssistantMessage(`Error: ${parsed.error}`);
            } else if (parsed.chapterDraft) {
              this.markLastAssistantAsDraft();
            } else if (parsed.beats) {
              this.setLastAssistantBeats(parsed.beats);
            } else if (parsed.navigate) {
              // The assistant invoked a navigation tool. Show a confirmation
              // message in the bubble (so it's never blank), navigate, and
              // leave the panel open so the user can continue the conversation.
              this.updateLastAssistantMessage(`Opening "${parsed.navigate.title}"…`);
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
            } else if (parsed.chapterUpdated) {
              this.chapterSync.notify(parsed.chapterUpdated);
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
      .map(({ role, text, imageUrl, thumbnailUrl, sources, kind, beats }) => ({
        role, text,
        ...(imageUrl ? { imageUrl } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        ...(sources?.length ? { sources } : {}),
        ...(kind ? { kind } : {}),
        ...(beats ? { beats } : {}),
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

  private setLastAssistantBeats(beats: string): void {
    this.messages.update(msgs => {
      if (msgs.length === 0) return msgs;
      const copy = [...msgs];
      copy[copy.length - 1] = { ...copy[copy.length - 1], beats };
      return copy;
    });
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
    const token = localStorage.getItem('app_auth_token');
    const headers = new Headers(init.headers as HeadersInit);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }
}
