import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ChapterCitation, ChatFolder, ChatSession, ChatSessionMessage, MapPreview } from '@shared/models';
import { Series } from '@shared/models/series.model';

/**
 * Backs the quick-launch "Ask Quill" overlay: an ephemeral, cross-series RAG
 * chat that isn't persisted unless the user explicitly saves it into the
 * Resource Manager. Kept separate from {@link AiAssistantService} (which owns
 * the heavier folder/session-management panel) so the overlay stays lightweight.
 */
@Injectable({ providedIn: 'root' })
export class QuickChatService {
  private readonly router = inject(Router);

  readonly isOpen = signal(false);
  readonly messages = signal<ChatSessionMessage[]>([]);
  readonly streaming = signal(false);

  private abortController: AbortController | null = null;

  open(): void {
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  toggle(): void {
    this.isOpen.update(v => !v);
  }

  /** Clears the conversation (e.g. after saving or via "New chat"). */
  reset(): void {
    this.cancelStreaming();
    this.messages.set([]);
  }

  async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.streaming()) return;

    const userMsg: ChatSessionMessage = { role: 'user', text: trimmed };
    const assistantPlaceholder: ChatSessionMessage = { role: 'assistant', text: '' };
    this.messages.update(list => [...list, userMsg, assistantPlaceholder]);
    this.streaming.set(true);

    // Keep context lean: last 3 prior exchanges (6 messages) + current = 7 max.
    const apiMessages = this.messages()
      .filter(m => m.text)
      .slice(-7)
      .map(m => ({ role: m.role, content: m.text }));

    this.abortController = new AbortController();

    try {
      const res = await this.authFetch('/api/chat-sessions/quick-chat', {
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
            const parsed = JSON.parse(data) as {
              content?: string;
              error?: string;
              sources?: ChapterCitation[];
              navigate?: { target: 'chapter' | 'book' | 'series' | 'entity'; id: string; title: string };
              map?: MapPreview;
            };
            if (parsed.error) {
              this.updateLastAssistantMessage(`Error: ${parsed.error}`);
            } else if (parsed.navigate) {
              // The assistant invoked a tool to take the user somewhere: act on
              // it, close the overlay, and stop reading the rest of the stream.
              this.cancelStreaming();
              this.close();
              this.router.navigate(this.routeFor(parsed.navigate.target, parsed.navigate.id));
              return;
            } else if (parsed.map) {
              // The assistant surfaced a map: attach it to the message so it
              // renders inline as a clickable thumbnail (overlay stays open).
              this.addMapToLastAssistantMessage(parsed.map);
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

  /** Loads the user's active series for the save picker (alphabetical). */
  async listSeries(): Promise<Series[]> {
    try {
      const res = await this.authFetch('/api/series');
      if (res.ok) {
        const data = await res.json() as Series[];
        return data
          .filter(s => !(s as { deleted?: boolean }).deleted && !(s as { archived?: boolean }).archived)
          .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
      }
    } catch {
      // Best-effort
    }
    return [];
  }

  /** Loads the chat folders for a series, used by the save picker tree. */
  async listFolders(seriesId: string): Promise<ChatFolder[]> {
    try {
      const res = await this.authFetch(`/api/chat-folders?seriesId=${encodeURIComponent(seriesId)}`);
      if (res.ok) return await res.json() as ChatFolder[];
    } catch {
      // Best-effort
    }
    return [];
  }

  /**
   * Persists the current conversation as a chat session in the Resource Manager
   * under the chosen series/folder, then auto-names it. Returns true on success.
   */
  async saveToResourceManager(seriesId: string, folderId: string | null): Promise<boolean> {
    const persistMessages = this.messages()
      .filter(m => m.text)
      .map(({ role, text, sources }) => ({
        role,
        text,
        ...(sources?.length ? { sources } : {}),
      }));
    if (persistMessages.length === 0) return false;

    try {
      const createRes = await this.authFetch('/api/chat-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, seriesId }),
      });
      if (!createRes.ok) return false;
      const session = await createRes.json() as ChatSession;

      await this.authFetch(`/api/chat-sessions/${session.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: persistMessages }),
      });

      // Best-effort title from the first exchange (mirrors the panel behavior).
      await this.authFetch(`/api/chat-sessions/${session.id}/name`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: persistMessages.slice(0, 2).map(m => ({ role: m.role, content: m.text })) }),
      });
      return true;
    } catch {
      return false;
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
