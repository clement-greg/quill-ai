import {
  ChangeDetectionStrategy, Component, OnDestroy, effect, inject, input,
  signal, untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { ChapterVersion } from '@shared/models/chapter.model';
import { ChapterVersionService } from '../chapter-version.service';
import { TextDiffViewComponent } from '@app/shared/text-diff-view/text-diff-view';

/** Sidebar tab that lists a chapter's saved versions and shows a word-level
 *  diff between the selected version and its predecessor. Loads lazily the
 *  first time its tab becomes active. */
@Component({
  selector: 'app-version-history-panel',
  imports: [MatButtonModule, MatIconModule, TextDiffViewComponent],
  templateUrl: './version-history-panel.html',
  styleUrl: './version-history-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VersionHistoryPanelComponent implements OnDestroy {
  chapterId = input<string | null>(null);
  /** True while this panel's sidebar tab is the active one. */
  active = input(false);

  private chapterVersionService = inject(ChapterVersionService);

  historyLoading = signal(false);
  historyVersions = signal<ChapterVersion[]>([]);
  selectedVersion = signal<ChapterVersion | null>(null);
  previousVersion = signal<ChapterVersion | null>(null);
  historyListHeight = signal(180);

  // Track emails whose avatar endpoint returned an error so we fall back to the placeholder icon
  private _avatarErrors = signal<ReadonlySet<string>>(new Set());
  avatarFailed(email: string): boolean { return this._avatarErrors().has(email); }
  onAvatarError(email: string): void { this._avatarErrors.update(s => new Set([...s, email])); }

  private historyResizerDrag: {
    startY: number; startHeight: number;
    moveHandler: (e: MouseEvent) => void; upHandler: () => void;
  } | null = null;

  private static readonly HISTORY_LIST_HEIGHT_KEY = 'chapter-edit-history-list-height';
  private static readonly HISTORY_LIST_MIN = 80;
  private static readonly HISTORY_LIST_MAX = 400;

  constructor() {
    this.loadHistoryListHeight();

    // Reset when navigating to a different chapter (the component instance
    // survives route param changes).
    let lastChapterId: string | null = null;
    effect(() => {
      const id = this.chapterId();
      if (id !== lastChapterId) {
        lastChapterId = id;
        untracked(() => this.reset());
      }
    });

    // Load versions the first time the tab becomes active.
    effect(() => {
      const isActive = this.active();
      const id = this.chapterId();
      if (isActive && id) {
        untracked(() => {
          if (!this.historyLoading() && this.historyVersions().length === 0) this.load();
        });
      }
    });
  }

  ngOnDestroy(): void {
    if (this.historyResizerDrag) {
      document.removeEventListener('mousemove', this.historyResizerDrag.moveHandler);
      document.removeEventListener('mouseup', this.historyResizerDrag.upHandler);
    }
  }

  private reset(): void {
    this.historyVersions.set([]);
    this.selectedVersion.set(null);
    this.previousVersion.set(null);
  }

  load(): void {
    const chapterId = this.chapterId();
    if (!chapterId) return;
    this.historyLoading.set(true);
    this.chapterVersionService.getByChapter(chapterId).subscribe({
      next: (versions) => { this.historyVersions.set(versions); this.historyLoading.set(false); },
      error: () => this.historyLoading.set(false),
    });
  }

  /** Reloads the list after a save, but only if it was already loaded. */
  refreshAfterSave(): void {
    if (this.historyVersions().length > 0) this.load();
  }

  selectVersion(version: ChapterVersion): void {
    this.selectedVersion.set(version);
    const versions = this.historyVersions();
    const idx = versions.findIndex(v => v.id === version.id);
    // versions are newest-first, so previous version is at idx+1
    const prev = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1] : null;
    this.previousVersion.set(prev);
  }

  formatVersionDate(savedAt: string): string {
    return new Date(savedAt).toLocaleString();
  }

  private loadHistoryListHeight(): void {
    const stored = localStorage.getItem(VersionHistoryPanelComponent.HISTORY_LIST_HEIGHT_KEY);
    if (stored) {
      const h = parseInt(stored, 10);
      if (!isNaN(h) && h >= VersionHistoryPanelComponent.HISTORY_LIST_MIN && h <= VersionHistoryPanelComponent.HISTORY_LIST_MAX) {
        this.historyListHeight.set(h);
      }
    }
  }

  onHistoryResizerMouseDown(event: MouseEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.historyListHeight();
    const moveHandler = (e: MouseEvent) => {
      const delta = e.clientY - startY;
      this.historyListHeight.set(Math.round(Math.max(
        VersionHistoryPanelComponent.HISTORY_LIST_MIN,
        Math.min(startHeight + delta, VersionHistoryPanelComponent.HISTORY_LIST_MAX),
      )));
    };
    const upHandler = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(VersionHistoryPanelComponent.HISTORY_LIST_HEIGHT_KEY, String(this.historyListHeight()));
      this.historyResizerDrag = null;
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
    this.historyResizerDrag = { startY, startHeight, moveHandler, upHandler };
  }
}
