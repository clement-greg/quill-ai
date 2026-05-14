import { Injectable, inject, signal, computed } from '@angular/core';
import { ChatFolder, ChatMessageHighlight, ChatSession, ChatSessionMessage, ChatSessionSummary, FolderFile, FolderNote } from '@shared/models';
import { Series } from '@shared/models/series.model';
import { SeriesContextService } from './series-context.service';

const PENDING_ID = '__pending__';

@Injectable({ providedIn: 'root' })
export class AiAssistantService {
  private readonly seriesContext = inject(SeriesContextService);

  // Panel open/closed state
  readonly isOpen = signal(false);

  // All session summaries (used for the sidebar list)
  readonly sessions = signal<ChatSessionSummary[]>([]);

  // All chat folders
  readonly folders = signal<ChatFolder[]>([]);

  // The currently active full session
  readonly activeSession = signal<ChatSession | null>(null);

  // True while streaming a response
  readonly streaming = signal(false);

  // True when the active session hasn't been saved to the DB yet
  readonly isPendingSession = computed(() => this.activeSession()?.id === PENDING_ID);

  // Series selector
  readonly allSeries = signal<Series[]>([]);
  readonly selectedSeriesId = signal<string | null>(null);
  readonly selectedSeries = computed(() =>
    this.allSeries().find(s => s.id === this.selectedSeriesId()) ?? null
  );

  readonly pinnedSessions = computed(() =>
    this.sessions().filter(s => s.pinned).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  );

  readonly recentSessions = computed(() =>
    this.sessions().filter(s => !s.pinned).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  );

  /** Auto-selects the series from context (e.g. current page) if none is selected yet. */
  autoDetectSeries(contextSeriesId: string | null): void {
    if (!this.selectedSeriesId() && contextSeriesId) {
      this.setSeriesId(contextSeriesId);
    }
  }

  async setSeriesId(id: string | null): Promise<void> {
    if (this.selectedSeriesId() === id) return;
    this.selectedSeriesId.set(id);
    this.sessions.set([]);
    this.folders.set([]);
    this.activeSession.set(null);
    if (id) {
      await Promise.all([this.loadSessions(), this.loadFolders()]);
    }
  }

  togglePanel(): void {
    const opening = !this.isOpen();
    this.isOpen.set(opening);
    if (opening) {
      this._applyContextSeriesOnOpen();
    }
  }

  private _applyContextSeriesOnOpen(): void {
    const contextId = this.seriesContext.currentSeriesId();
    const loadSeriesFirst = this.allSeries().length === 0;
    const seriesChanged = contextId && contextId !== this.selectedSeriesId();

    if (loadSeriesFirst) {
      this.loadAllSeries().then(() => {
        if (contextId && contextId !== this.selectedSeriesId()) {
          this.setSeriesId(contextId);
        } else if (this.selectedSeriesId() && this.sessions().length === 0) {
          this.loadSessions();
          this.loadFolders();
        }
      });
    } else if (seriesChanged) {
      this.setSeriesId(contextId);
    } else if (this.selectedSeriesId() && this.sessions().length === 0) {
      this.loadSessions();
      this.loadFolders();
    }
  }

  openPanel(): void {
    this.isOpen.set(true);
    this._applyContextSeriesOnOpen();
  }

  closePanel(): void {
    this.isOpen.set(false);
  }

  async loadAllSeries(): Promise<void> {
    try {
      const res = await this.authFetch('/api/series');
      if (res.ok) {
        const data = await res.json() as Series[];
        const active = data.filter((s: any) => !s.deleted && !s.archived)
          .sort((a: Series, b: Series) => (a.title ?? '').localeCompare(b.title ?? ''));
        this.allSeries.set(active);
        // Auto-select if only one series exists
        if (active.length === 1 && !this.selectedSeriesId()) {
          await this.setSeriesId(active[0].id);
        }
      }
    } catch {
      // Best-effort
    }
  }

  async loadSessions(): Promise<void> {
    try {
      const seriesId = this.selectedSeriesId();
      const url = seriesId ? `/api/chat-sessions?seriesId=${encodeURIComponent(seriesId)}` : '/api/chat-sessions';
      const res = await this.authFetch(url);
      if (res.ok) {
        const data = await res.json() as ChatSessionSummary[];
        this.sessions.set(data);
      }
    } catch {
      // Best-effort
    }
  }

  async loadFolders(): Promise<void> {
    try {
      const seriesId = this.selectedSeriesId();
      const url = seriesId ? `/api/chat-folders?seriesId=${encodeURIComponent(seriesId)}` : '/api/chat-folders';
      const res = await this.authFetch(url);
      if (res.ok) {
        const data = await res.json() as ChatFolder[];
        this.folders.set(data);
      }
    } catch {
      // Best-effort
    }
  }

  async createFolder(name: string, parentFolderId: string | null): Promise<ChatFolder | null> {
    try {
      const res = await this.authFetch('/api/chat-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentFolderId, seriesId: this.selectedSeriesId() }),
      });
      if (res.ok) {
        const folder = await res.json() as ChatFolder;
        this.folders.update(list => [...list, folder]);
        return folder;
      }
    } catch {
      // Best-effort
    }
    return null;
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    try {
      await this.authFetch(`/api/chat-folders/${folderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.folders.update(list => list.map(f => f.id === folderId ? { ...f, name } : f));
    } catch {
      // Best-effort
    }
  }

  async deleteFolder(folderId: string): Promise<void> {
    try {
      const folder = this.folders().find(f => f.id === folderId);
      const parentFolderId = folder?.parentFolderId ?? null;
      await this.authFetch(`/api/chat-folders/${folderId}`, { method: 'DELETE' });
      // Re-parent child folders and sessions optimistically
      this.folders.update(list =>
        list
          .filter(f => f.id !== folderId)
          .map(f => f.parentFolderId === folderId ? { ...f, parentFolderId } : f)
      );
      this.sessions.update(list =>
        list.map(s => s.folderId === folderId ? { ...s, folderId: parentFolderId } : s)
      );
    } catch {
      // Best-effort
    }
  }

  async moveFolderToFolder(folderId: string, parentFolderId: string | null): Promise<void> {
    try {
      await this.authFetch(`/api/chat-folders/${folderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentFolderId }),
      });
      this.folders.update(list =>
        list.map(f => f.id === folderId ? { ...f, parentFolderId } : f)
      );
    } catch {
      // Best-effort
    }
  }

  async moveSessionToFolder(sessionId: string, folderId: string | null): Promise<void> {
    try {
      await this.authFetch(`/api/chat-sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      this.sessions.update(list =>
        list.map(s => s.id === sessionId ? { ...s, folderId } : s)
      );
    } catch {
      // Best-effort
    }
  }

  /** Show an empty chat locally without hitting the DB yet. */
  startPendingSession(folderId?: string | null): void {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: PENDING_ID,
      name: 'New Chat',
      pinned: false,
      folderId: folderId ?? null,
      seriesId: this.selectedSeriesId(),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.activeSession.set(session);
  }

  async createSession(): Promise<ChatSession | null> {
    const folderId = this.activeSession()?.folderId ?? null;
    const seriesId = this.activeSession()?.seriesId ?? this.selectedSeriesId();
    try {
      const res = await this.authFetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, seriesId }),
      });
      if (res.ok) {
        const session = await res.json() as ChatSession;
        const summary: ChatSessionSummary = {
          id: session.id,
          name: session.name,
          pinned: session.pinned,
          folderId: session.folderId,
          seriesId: session.seriesId,
          updatedAt: session.updatedAt,
        };
        this.sessions.update(list => [summary, ...list]);
        this.activeSession.set(session);
        return session;
      }
    } catch {
      // Fall through
    }
    return null;
  }

  async openSession(id: string): Promise<void> {
    try {
      const res = await this.authFetch(`/api/chat-sessions/${id}`);
      if (res.ok) {
        const session = await res.json() as ChatSession;
        this.activeSession.set(session);
      }
    } catch {
      // Best-effort
    }
  }

  async togglePin(sessionId: string): Promise<void> {
    const summary = this.sessions().find(s => s.id === sessionId);
    if (!summary) return;
    const newPinned = !summary.pinned;
    try {
      await this.authFetch(`/api/chat-sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: newPinned }),
      });
      this.sessions.update(list =>
        list.map(s => s.id === sessionId ? { ...s, pinned: newPinned } : s)
      );
    } catch {
      // Best-effort
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    try {
      await this.authFetch(`/api/chat-sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      this.sessions.update(list =>
        list.map(s => s.id === sessionId ? { ...s, name } : s)
      );
      const active = this.activeSession();
      if (active?.id === sessionId) {
        this.activeSession.set({ ...active, name });
      }
    } catch {
      // Best-effort
    }
  }

  closeActiveSession(): void {
    this.activeSession.set(null);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // If the session was never saved, just clear it locally
    if (sessionId === PENDING_ID) {
      this.activeSession.set(null);
      return;
    }
    try {
      await this.authFetch(`/api/chat-sessions/${sessionId}/archive`, { method: 'POST' });
      this.sessions.update(list => list.filter(s => s.id !== sessionId));
      if (this.activeSession()?.id === sessionId) {
        this.activeSession.set(null);
      }
    } catch {
      // Best-effort
    }
  }

  async getArchivedSessions(): Promise<ChatSessionSummary[]> {
    try {
      const res = await this.authFetch('/api/chat-sessions/archived');
      if (res.ok) return await res.json() as ChatSessionSummary[];
    } catch {
      // Best-effort
    }
    return [];
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    await this.authFetch(`/api/chat-sessions/${sessionId}/restore`, { method: 'POST' });
  }

  async deleteChatSessionPermanent(sessionId: string): Promise<void> {
    await this.authFetch(`/api/chat-sessions/${sessionId}`, { method: 'DELETE' });
  }

  private abortController: AbortController | null = null;

  private isImageRequest(text: string): boolean {
    return /\b(generate|create|draw|make|produce|illustrate)\b[\s\S]{0,60}\b(image|picture|illustration|artwork|photo|painting|photograph)\b/i.test(text) ||
           /\b(image|draw|illustrate|paint|photo)\s*:/i.test(text);
  }

  async sendMessage(text: string): Promise<void> {
    let session = this.activeSession();
    if (!session || this.streaming()) return;

    // Materialise a pending session before sending the first message
    if (session.id === PENDING_ID) {
      const created = await this.createSession();
      if (!created) {
        this.updateLastAssistantMessage('Error: could not create chat session.');
        return;
      }
      session = created;
    }

    const userMsg: ChatSessionMessage = { role: 'user', text };
    const updatedMessages: ChatSessionMessage[] = [...session.messages, userMsg];

    // ── Image generation path ────────────────────────────────────────────────
    if (this.isImageRequest(text)) {
      const generatingPlaceholder: ChatSessionMessage = { role: 'assistant', text: 'Generating image…', generatingImage: true };
      this.activeSession.set({ ...session, messages: [...updatedMessages, generatingPlaceholder] });
      this.streaming.set(true);

      try {
        const imgRes = await this.authFetch('/api/image/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: text }),
        });
        if (imgRes.ok) {
          const imgData = await imgRes.json() as { url: string; thumbnailUrl: string };
          this.updateLastAssistantMessage('');
          this.setLastAssistantImageUrl(imgData.url);
        } else {
          this.updateLastAssistantMessage('Error: image generation failed.');
          this.clearLastAssistantGenerating();
        }
      } catch {
        this.updateLastAssistantMessage('Error: could not connect to image generation service.');
        this.clearLastAssistantGenerating();
      } finally {
        this.streaming.set(false);
        await this.persistSessionMessages(session.id);
        if (session.name === 'New Chat' && updatedMessages.length === 1) {
          this.autoNameSession(session.id, updatedMessages.map(m => ({ role: m.role, content: m.text })));
        }
      }
      return;
    }

    // ── Text streaming path ──────────────────────────────────────────────────
    const assistantPlaceholder: ChatSessionMessage = { role: 'assistant', text: '' };

    this.activeSession.set({ ...session, messages: [...updatedMessages, assistantPlaceholder] });
    this.streaming.set(true);

    // Keep context lean: last 3 prior exchanges (6 messages) + current user message = 7 max
    const apiMessages = updatedMessages.slice(-7).map(m => ({ role: m.role, content: m.text }));

    this.abortController = new AbortController();

    try {
      const res = await this.authFetch(`/api/chat-sessions/${session.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages }),
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
            const parsed = JSON.parse(data) as { content?: string; error?: string };
            if (parsed.error) {
              this.updateLastAssistantMessage(`Error: ${parsed.error}`);
            } else if (parsed.content) {
              this.appendToLastAssistantMessage(parsed.content);
            }
          } catch {
            // Skip malformed SSE chunk
          }
        }
      }

      // Persist the completed exchange
      await this.persistSessionMessages(session.id);

      // Auto-name the session after the first exchange
      if (session.name === 'New Chat' && updatedMessages.length === 1) {
        this.autoNameSession(session.id, apiMessages);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        this.updateLastAssistantMessage('Error: could not connect to AI.');
      }
    } finally {
      this.streaming.set(false);
      this.abortController = null;
    }
  }

  async addHighlight(messageIndex: number, highlight: ChatMessageHighlight): Promise<void> {
    const session = this.activeSession();
    if (!session) return;
    const updated = session.messages.map((m, i) =>
      i === messageIndex ? { ...m, highlights: [...(m.highlights ?? []), highlight] } : m
    );
    this.activeSession.set({ ...session, messages: updated });
    await this.persistSessionMessages(session.id);
  }

  async removeHighlightsInRange(messageIndex: number, startOffset: number, endOffset: number): Promise<void> {
    const session = this.activeSession();
    if (!session) return;
    const updated = session.messages.map((m, i) => {
      if (i !== messageIndex || !m.highlights?.length) return m;
      const filtered = m.highlights.filter(h => h.endOffset <= startOffset || h.startOffset >= endOffset);
      return { ...m, highlights: filtered };
    });
    this.activeSession.set({ ...session, messages: updated });
    await this.persistSessionMessages(session.id);
  }

  async removeHighlight(messageIndex: number, highlightId: string): Promise<void> {
    const session = this.activeSession();
    if (!session) return;
    const updated = session.messages.map((m, i) => {
      if (i !== messageIndex || !m.highlights?.length) return m;
      return { ...m, highlights: m.highlights.filter(h => h.id !== highlightId) };
    });
    this.activeSession.set({ ...session, messages: updated });
    await this.persistSessionMessages(session.id);
  }

  private async persistSessionMessages(sessionId: string): Promise<void> {
    const finalSession = this.activeSession();
    if (!finalSession) return;
    const persistMessages = finalSession.messages
      .filter(m => m.text || m.imageUrl)
      .map(({ role, text, imageUrl, highlights }) => ({
        role,
        text,
        ...(imageUrl ? { imageUrl } : {}),
        ...(highlights?.length ? { highlights } : {}),
      }));
    try {
      await this.authFetch(`/api/chat-sessions/${sessionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: persistMessages }),
      });
    } catch {
      // Best-effort
    }
    const now = new Date().toISOString();
    this.sessions.update(list =>
      list.map(s => s.id === sessionId ? { ...s, updatedAt: now } : s)
    );
  }

  private setLastAssistantImageUrl(imageUrl: string): void {
    this.activeSession.update(s => {
      if (!s) return s;
      const msgs = [...s.messages];
      msgs[msgs.length - 1] = { role: 'assistant', text: '', imageUrl, generatingImage: false };
      return { ...s, messages: msgs };
    });
  }

  private clearLastAssistantGenerating(): void {
    this.activeSession.update(s => {
      if (!s) return s;
      const msgs = [...s.messages];
      msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], generatingImage: false };
      return { ...s, messages: msgs };
    });
  }

  private async autoNameSession(
    sessionId: string,
    messages: { role: string; content: string }[]
  ): Promise<void> {
    try {
      const res = await this.authFetch(`/api/chat-sessions/${sessionId}/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      if (res.ok) {
        const { name } = await res.json() as { name: string };
        this.sessions.update(list =>
          list.map(s => s.id === sessionId ? { ...s, name } : s)
        );
        const active = this.activeSession();
        if (active?.id === sessionId) {
          this.activeSession.set({ ...active, name });
        }
      }
    } catch {
      // Best-effort
    }
  }

  cancelStreaming(): void {
    this.abortController?.abort();
  }

  private updateLastAssistantMessage(text: string): void {
    this.activeSession.update(s => {
      if (!s) return s;
      const msgs = [...s.messages];
      msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], text };
      return { ...s, messages: msgs };
    });
  }

  private appendToLastAssistantMessage(delta: string): void {
    this.activeSession.update(s => {
      if (!s) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      msgs[msgs.length - 1] = { ...last, text: last.text + delta };
      return { ...s, messages: msgs };
    });
  }

  // ── Folder files ──────────────────────────────────────────────────────────

  async listFolderFiles(folderId: string): Promise<FolderFile[]> {
    try {
      const res = await this.authFetch(`/api/folder-files/${folderId}`);
      if (res.ok) return await res.json() as FolderFile[];
    } catch { /* best-effort */ }
    return [];
  }

  async uploadFolderFile(folderId: string, file: File): Promise<FolderFile | null> {
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await this.authFetch(`/api/folder-files/${folderId}`, { method: 'POST', body: form });
      if (res.ok) return await res.json() as FolderFile;
    } catch { /* best-effort */ }
    return null;
  }

  async renameFolderFile(folderId: string, fileId: string, name: string): Promise<void> {
    try {
      await this.authFetch(`/api/folder-files/${folderId}/${fileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch { /* best-effort */ }
  }

  async moveFolderFile(fromFolderId: string, fileId: string, toFolderId: string): Promise<void> {
    try {
      await this.authFetch(`/api/folder-files/${fromFolderId}/${fileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: toFolderId }),
      });
    } catch { /* best-effort */ }
  }

  async deleteFolderFile(folderId: string, fileId: string): Promise<void> {
    try {
      await this.authFetch(`/api/folder-files/${folderId}/${fileId}`, { method: 'DELETE' });
    } catch { /* best-effort */ }
  }

  folderFilePreviewUrl(folderId: string, fileId: string): string {
    return `/api/folder-files/${folderId}/${fileId}/preview`;
  }

  async fetchFolderFileBlob(folderId: string, fileId: string): Promise<Blob> {
    const res = await this.authFetch(`/api/folder-files/${folderId}/${fileId}/preview`);
    if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
    return res.blob();
  }

  folderFileDownloadUrl(folderId: string, fileId: string): string {
    return `/api/folder-files/${folderId}/${fileId}/download`;
  }

  // ── Folder notes ──────────────────────────────────────────────────────────

  async listFolderNotes(folderId: string): Promise<FolderNote[]> {
    try {
      const res = await this.authFetch(`/api/folder-notes/${folderId}`);
      if (res.ok) return await res.json() as FolderNote[];
    } catch { /* best-effort */ }
    return [];
  }

  async getFolderNote(folderId: string, noteId: string): Promise<FolderNote | null> {
    try {
      const res = await this.authFetch(`/api/folder-notes/${folderId}/${noteId}`);
      if (res.ok) return await res.json() as FolderNote;
    } catch { /* best-effort */ }
    return null;
  }

  async createFolderNote(folderId: string, seriesId?: string): Promise<FolderNote | null> {
    try {
      const res = await this.authFetch(`/api/folder-notes/${folderId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '', seriesId }),
      });
      if (res.ok) return await res.json() as FolderNote;
    } catch { /* best-effort */ }
    return null;
  }

  async saveFolderNote(folderId: string, noteId: string, content: string): Promise<FolderNote | null> {
    try {
      const res = await this.authFetch(`/api/folder-notes/${folderId}/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) return await res.json() as FolderNote;
    } catch { /* best-effort */ }
    return null;
  }

  async renameFolderNote(folderId: string, noteId: string, name: string): Promise<void> {
    try {
      await this.authFetch(`/api/folder-notes/${folderId}/${noteId}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch { /* best-effort */ }
  }

  async deleteFolderNote(folderId: string, noteId: string): Promise<void> {
    try {
      await this.authFetch(`/api/folder-notes/${folderId}/${noteId}`, { method: 'DELETE' });
    } catch { /* best-effort */ }
  }

  private authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const token = localStorage.getItem('app_auth_token');
    const headers = new Headers(init.headers as HeadersInit);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }
}
