import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { dialogueBlocks } from '@app/core/read-aloud/dialogue-paragraphs';
import { Chapter } from '@shared/models/chapter.model';
import { ChapterDialogue, DialogueParagraph, DialogueTagRequest } from '@shared/models/dialogue.model';

/** Untagged paragraphs sent per request, so colors appear as each batch finishes. */
export const TAG_CHUNK = 20;

/** How far along a chapter's tagging is, in paragraphs. */
export interface TaggingProgress {
  done: number;
  total: number;
}

/** Paragraphs of lead-up sent with each untagged one, and how much of them. */
const CONTEXT_PARAGRAPHS = 2;
const CONTEXT_CHARS = 600;

/** What to send for a saved chapter, or null when its stored attributions
 *  already match its dialogue exactly (nothing new, nothing removed). */
export function dialogueTagRequest(chapter: Pick<Chapter, 'content' | 'dialogue'>): DialogueTagRequest | null {
  const blocks = dialogueBlocks(chapter.content ?? '');
  const known: ChapterDialogue = chapter.dialogue ?? {};
  const keys: string[] = [];
  const pending: DialogueParagraph[] = [];
  blocks.forEach((block, i) => {
    if (!block.key) return;
    keys.push(block.key);
    if (block.key in known || pending.some(p => p.key === block.key)) return;
    const context = blocks.slice(Math.max(0, i - CONTEXT_PARAGRAPHS), i).map(b => b.text).join(' ').slice(-CONTEXT_CHARS);
    pending.push({ key: block.key, text: block.text, spans: block.spans, ...(context ? { context } : {}) });
  });
  const keySet = new Set(keys);
  const removed = Object.keys(known).some(k => !keySet.has(k));
  return pending.length || removed ? { keys, pending } : null;
}

/**
 * After a chapter save, works out who speaks each new or edited line of
 * dialogue (POST /api/chapters/:id/dialogue) so read-aloud can use character
 * voices. Lines already attributed are never sent to the model again; an
 * edited paragraph gets a new key, so its old attribution is dropped and it is
 * attributed afresh. Runs in the background and never fails a save.
 */
@Injectable({ providedIn: 'root' })
export class DialogueTaggingService {
  private readonly http = inject(HttpClient);
  /** Chapters being tagged, with the newest save that arrived meanwhile. */
  private readonly running = new Map<string, Chapter | null>();

  /** The latest known speakers per chapter id (from loads, tagging and corrections). */
  readonly dialogue = signal<Readonly<Record<string, ChapterDialogue>>>({});
  /** Chapters whose new dialogue is being attributed right now. */
  readonly tagging = signal<ReadonlySet<string>>(new Set());
  /** Progress of each chapter being attributed. */
  readonly progress = signal<Readonly<Record<string, TaggingProgress>>>({});

  /** Records a chapter's stored speakers as loaded from the server. */
  seed(chapter: Pick<Chapter, 'id' | 'dialogue'>): void {
    if (!chapter?.id || this.running.has(chapter.id)) return;
    this.setDialogue(chapter.id, chapter.dialogue ?? {});
  }

  /** Tags the saved chapter's dialogue (call with the server's response). */
  tag(chapter: Chapter): void {
    if (!chapter?.id) return;
    if (this.running.has(chapter.id)) {
      this.running.set(chapter.id, chapter);
      return;
    }
    this.running.set(chapter.id, null);
    this.tagging.update(s => new Set(s).add(chapter.id));
    void this.run(chapter);
  }

  /**
   * Corrects who speaks one line (span `index` of the paragraph with that key); null reads it
   * in the narration voice. Updates right away and rolls back if the server
   * refuses. Resolves to an error message, or null on success.
   */
  async setSpeaker(chapterId: string, key: string, index: number, entityId: string | null): Promise<string | null> {
    const before = this.dialogue()[chapterId];
    const speakers = before?.[key];
    if (!before || !speakers || index >= speakers.length) return 'Save the chapter first, so this line has a speaker to change.';
    const next = [...speakers];
    next[index] = entityId;
    this.setDialogue(chapterId, { ...before, [key]: next });
    try {
      const res = await firstValueFrom(this.http.patch<{ dialogue: ChapterDialogue }>(
        `/api/chapters/${encodeURIComponent(chapterId)}/dialogue`, { key, index, entityId }));
      this.setDialogue(chapterId, res.dialogue);
      return null;
    } catch (err) {
      this.setDialogue(chapterId, before);
      const message = (err as { error?: { error?: string } })?.error?.error;
      return message ?? 'Couldn’t change the speaker. Try again.';
    }
  }

  private setDialogue(chapterId: string, dialogue: ChapterDialogue): void {
    this.dialogue.update(all => ({ ...all, [chapterId]: dialogue }));
  }

  private async run(chapter: Chapter): Promise<void> {
    const id = chapter.id;
    try {
      const dialogue = this.dialogue()[id] ?? chapter.dialogue;
      const request = dialogueTagRequest({ content: chapter.content, dialogue });
      if (!request) {
        if (dialogue) this.setDialogue(id, dialogue);
      } else {
        // One batch at a time (each request rewrites the chapter's map, so they
        // mustn't overlap), showing each batch's speakers as it lands.
        const chunks = request.pending.length
          ? Array.from({ length: Math.ceil(request.pending.length / TAG_CHUNK) },
            (_, i) => request.pending.slice(i * TAG_CHUNK, (i + 1) * TAG_CHUNK))
          : [[]];
        const total = request.pending.length;
        this.setProgress(id, { done: 0, total });
        let done = 0;
        for (const pending of chunks) {
          const res = await firstValueFrom(this.http.post<{ dialogue: ChapterDialogue }>(
            `/api/chapters/${encodeURIComponent(id)}/dialogue`, { keys: request.keys, pending }));
          this.setDialogue(id, res.dialogue);
          done += pending.length;
          this.setProgress(id, { done, total });
          // A newer save is waiting: it starts over from the latest text.
          if (this.running.get(id)) break;
        }
      }
    } catch {
      // Best effort: untagged lines are read in the narration voice, and the next save tries again.
    }
    const next = this.running.get(id);
    this.running.delete(id);
    if (next) {
      this.tag(next);
    } else {
      this.tagging.update(s => { const out = new Set(s); out.delete(id); return out; });
      this.setProgress(id, null);
    }
  }

  private setProgress(chapterId: string, progress: TaggingProgress | null): void {
    this.progress.update(all => {
      const out = { ...all };
      if (progress) out[chapterId] = progress;
      else delete out[chapterId];
      return out;
    });
  }
}
