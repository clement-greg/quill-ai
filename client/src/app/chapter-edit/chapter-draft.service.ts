import { Injectable } from '@angular/core';
import { ChapterNote, OutlineItem } from '@shared/models/chapter.model';

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
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id, content, notes, outline, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
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
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
