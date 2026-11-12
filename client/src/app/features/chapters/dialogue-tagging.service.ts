import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { dialogueBlocks } from '@app/core/read-aloud/dialogue-paragraphs';
import { Chapter } from '@shared/models/chapter.model';
import { ChapterDialogue, DialogueParagraph, DialogueTagRequest } from '@shared/models/dialogue.model';

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
  /** The latest attributions per chapter, which a save's response may not have yet. */
  private readonly latest = new Map<string, ChapterDialogue>();

  /** Tags the saved chapter's dialogue (call with the server's response). */
  tag(chapter: Chapter): void {
    if (!chapter?.id) return;
    if (this.running.has(chapter.id)) {
      this.running.set(chapter.id, chapter);
      return;
    }
    this.running.set(chapter.id, null);
    void this.run(chapter);
  }

  private async run(chapter: Chapter): Promise<void> {
    try {
      const dialogue = this.latest.get(chapter.id) ?? chapter.dialogue;
      const request = dialogueTagRequest({ content: chapter.content, dialogue });
      if (request) {
        const res = await firstValueFrom(
          this.http.post<{ dialogue: ChapterDialogue }>(`/api/chapters/${encodeURIComponent(chapter.id)}/dialogue`, request));
        this.latest.set(chapter.id, res.dialogue);
      }
    } catch {
      // Best effort: untagged lines are read in the narration voice, and the next save tries again.
    }
    const next = this.running.get(chapter.id);
    this.running.delete(chapter.id);
    if (next) this.tag(next);
  }
}
