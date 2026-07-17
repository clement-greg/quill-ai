import { Injectable, signal } from '@angular/core';
import { Chapter, ChapterNote, OutlineItem } from '@shared/models/chapter.model';

const DB_NAME = 'story-time';
const STORE_NAME = 'chapter-drafts';
const DB_VERSION = 1;

export interface ChapterDraft {
  content: string;
  notes: ChapterNote[];
  outline: OutlineItem[];
  savedAt: number; // Date.now() ms
}

@Injectable({ providedIn: 'root' })
export class ChapterDraftService {
  private db: IDBDatabase | null = null;

  /** Ids of chapters that currently have a cached, unsaved draft. */
  readonly draftIds = signal<ReadonlySet<string>>(new Set());

  constructor() {
    this.refreshDraftIds();
  }

  private async refreshDraftIds(): Promise<void> {
    const db = await this.open();
    const ids = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
    this.draftIds.set(new Set(ids));
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveDraft(id: string, content: string, notes: ChapterNote[] = [], outline: OutlineItem[] = []): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id, content, notes, outline, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    this.draftIds.update(ids => (ids.has(id) ? ids : new Set(ids).add(id)));
  }

  async getDraft(id: string): Promise<ChapterDraft | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        const result = request.result;
        if (!result) { resolve(null); return; }
        resolve({ content: result.content ?? '', notes: result.notes ?? [], outline: result.outline ?? [], savedAt: result.savedAt ?? 0 });
      };
      request.onerror = () => reject(request.error);
    });
  }

  async clearDraft(id: string): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (this.draftIds().has(id)) {
      this.draftIds.update(ids => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  }

  /**
   * Looks up the cached draft for a chapter and checks whether it's a genuine
   * pending change against the server's copy — a draft older than the server's
   * `modifiedAt`, or one whose content/outline match the server exactly, is a
   * stale leftover rather than an unsaved edit. Stale drafts are cleared as a
   * side effect so they stop showing up as pending elsewhere (e.g. the header's
   * unsaved-drafts menu).
   */
  async resolvePendingDraft(chapter: Pick<Chapter, 'id' | 'content' | 'outline' | 'modifiedAt'>): Promise<ChapterDraft | null> {
    const draft = await this.getDraft(chapter.id);
    if (!draft) return null;

    const serverMs = chapter.modifiedAt ? new Date(chapter.modifiedAt).getTime() : 0;
    const isStale = serverMs > draft.savedAt;
    const contentDiffers = !isStale && draft.content !== (chapter.content ?? '');
    const outlineDiffers = !isStale && JSON.stringify(draft.outline ?? []) !== JSON.stringify(chapter.outline ?? []);

    if (contentDiffers || outlineDiffers) return draft;

    await this.clearDraft(chapter.id);
    return null;
  }
}
