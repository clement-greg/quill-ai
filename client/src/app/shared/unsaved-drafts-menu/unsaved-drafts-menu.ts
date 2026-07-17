import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { MatMenuModule } from '@angular/material/menu';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { Chapter } from '@shared/models/chapter.model';
import { ChapterService } from '@app/features/chapters/chapter.service';
import { ChapterDraftService } from '@app/features/chapters/chapter-edit/chapter-draft.service';

@Component({
  selector: 'app-unsaved-drafts-menu',
  imports: [RouterLink, MatMenuModule, MatIconModule, MatButtonModule],
  templateUrl: './unsaved-drafts-menu.html',
  styleUrl: './unsaved-drafts-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UnsavedDraftsMenuComponent {
  private chapterService = inject(ChapterService);
  private draftService = inject(ChapterDraftService);

  private allChapters = toSignal(this.chapterService.getAll(), { initialValue: [] as Chapter[] });

  /**
   * A draft id in IndexedDB doesn't necessarily mean a pending change — it may
   * be stale (server was edited elsewhere) or identical to what's on the
   * server. Cross-check each candidate against `resolvePendingDraft`, which
   * mirrors chapter-edit's own logic and clears out ghost drafts as it goes.
   */
  draftChapters = signal<Chapter[]>([]);

  count = computed(() => this.draftChapters().length);

  private recomputeEffect = effect(() => {
    const ids = this.draftService.draftIds();
    const candidates = this.allChapters().filter(chapter => ids.has(chapter.id));
    untracked(() => this.verify(candidates));
  });

  private async verify(candidates: Chapter[]): Promise<void> {
    const pending: Chapter[] = [];
    for (const chapter of candidates) {
      const draft = await this.draftService.resolvePendingDraft(chapter);
      if (draft) pending.push(chapter);
    }
    this.draftChapters.set(pending);
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }
}
