import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Chapter } from '@shared/models/chapter.model';
import { AuthService } from '@app/core/auth/auth.service';
import { ChapterService } from '@app/features/chapters/chapter.service';
import { ChapterDraftService } from './chapter-draft.service';

/**
 * The chapters with unsaved local drafts, shared by the toolbar's drafts menu
 * and the desktop app's native File menu (which needs it while the toolbar is
 * hidden).
 */
@Injectable({ providedIn: 'root' })
export class UnsavedDraftsService {
  private auth = inject(AuthService);
  private chapterService = inject(ChapterService);
  private draftService = inject(ChapterDraftService);

  private allChapters = signal<Chapter[]>([]);

  /**
   * A draft id in IndexedDB doesn't necessarily mean a pending change — it may
   * be stale (server was edited elsewhere) or identical to what's on the
   * server. Cross-check each candidate against `resolvePendingDraft`, which
   * mirrors chapter-edit's own logic and clears out ghost drafts as it goes.
   */
  private _chapters = signal<Chapter[]>([]);
  readonly chapters = this._chapters.asReadonly();

  constructor() {
    effect(() => {
      if (this.auth.currentUser()) {
        untracked(() => this.chapterService.getAll().subscribe({
          next: chapters => this.allChapters.set(chapters),
          error: () => {},
        }));
      } else {
        this.allChapters.set([]);
      }
    });

    effect(() => {
      const ids = this.draftService.draftIds();
      const candidates = this.allChapters().filter(chapter => ids.has(chapter.id));
      untracked(() => this.verify(candidates));
    });
  }

  private async verify(candidates: Chapter[]): Promise<void> {
    const pending: Chapter[] = [];
    for (const chapter of candidates) {
      const draft = await this.draftService.resolvePendingDraft(chapter);
      if (draft) pending.push(chapter);
    }
    this._chapters.set(pending);
  }
}
