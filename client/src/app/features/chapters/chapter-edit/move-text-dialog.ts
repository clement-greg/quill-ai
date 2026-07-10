import { Component, ChangeDetectionStrategy, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Chapter } from '@shared/models/chapter.model';
import { ChapterService } from '../chapter.service';
import { BlockAnchor, ContentBlock, parseContentBlocks } from './chapter-content-blocks';

export interface MoveTextDialogData {
  bookId: string;
  currentChapterId: string;
  /** Plain text of the selection, shown so the user knows what's moving. */
  selectionPreview: string;
}

export type MoveTextDialogResult =
  | { mode: 'new'; title: string; sortOrder: number }
  | {
      mode: 'existing';
      /** The freshly-fetched target chapter (content included). */
      chapter: Chapter;
      /** Node-path anchor of the chosen paragraph; null = append at the end. */
      anchor: BlockAnchor | null;
      position: 'before' | 'after';
    };

const ABBREVIATE_THRESHOLD = 160;

@Component({
  selector: 'app-move-text-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
    MatInputModule, MatFormFieldModule, MatProgressSpinnerModule,
  ],
  template: `
    @if (step() === 'target') {
      <h2 mat-dialog-title>Move text to…</h2>
      <mat-dialog-content>
        <p class="selection-preview">"{{ preview }}"</p>
        @if (loading()) {
          <div class="spinner-wrap"><mat-spinner diameter="28" /></div>
        } @else {
          <button class="option-row" [class.selected]="newChapterMode()" (click)="startNewChapter()">
            <mat-icon aria-hidden="true">add</mat-icon>
            <span>New chapter</span>
          </button>
          @if (newChapterMode()) {
            <mat-form-field appearance="outline" class="title-field">
              <mat-label>Chapter title</mat-label>
              <input matInput [ngModel]="newTitle()" (ngModelChange)="newTitle.set($event)"
                (keydown.enter)="confirmNew()" cdkFocusInitial />
            </mat-form-field>
          }
          @if (targets().length > 0) {
            <div class="list-label">Or an existing chapter</div>
            @for (c of targets(); track c.id) {
              <button class="option-row" (click)="chooseExisting(c)">
                <mat-icon aria-hidden="true">menu_book</mat-icon>
                <span class="option-title">{{ c.title || 'Chapter' }}</span>
                <mat-icon class="chevron" aria-hidden="true">chevron_right</mat-icon>
              </button>
            }
          } @else {
            <p class="empty-note">No other chapters in this book yet.</p>
          }
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button [mat-dialog-close]="undefined">Cancel</button>
        @if (newChapterMode()) {
          <button mat-flat-button color="primary" [disabled]="!newTitle().trim()" (click)="confirmNew()">
            Move to new chapter
          </button>
        }
      </mat-dialog-actions>
    } @else {
      <h2 mat-dialog-title class="position-title">
        <button mat-icon-button (click)="backToTargets()" aria-label="Back to chapter list">
          <mat-icon>arrow_back</mat-icon>
        </button>
        <span>Place in "{{ targetChapter()?.title || 'Chapter' }}"</span>
      </h2>
      <mat-dialog-content>
        @if (targetLoading()) {
          <div class="spinner-wrap"><mat-spinner diameter="28" /></div>
        } @else if (paragraphs().length === 0) {
          <p class="empty-note">This chapter is empty — the moved text will become its content.</p>
        } @else {
          <div class="position-toggle" role="radiogroup" aria-label="Insert position">
            <button class="toggle-btn" role="radio" [attr.aria-checked]="position() === 'before'"
              [class.selected]="position() === 'before'" (click)="position.set('before')">
              Insert before
            </button>
            <button class="toggle-btn" role="radio" [attr.aria-checked]="position() === 'after'"
              [class.selected]="position() === 'after'" (click)="position.set('after')">
              Insert after
            </button>
            <span class="toggle-label">the selected paragraph:</span>
          </div>
          <div class="para-list" role="radiogroup" aria-label="Target paragraph">
            @for (p of paragraphs(); track $index; let i = $index) {
              <div class="para-row" [class.selected]="selectedIndex() === i">
                <button class="para-text" role="radio" [attr.aria-checked]="selectedIndex() === i"
                  (click)="selectedIndex.set(i)">
                  {{ isExpanded(i) ? p.text : abbreviate(p.text) }}
                </button>
                @if (p.text.length > abbreviateThreshold) {
                  <button mat-icon-button class="expand-btn" (click)="toggleExpanded(i)"
                    [attr.aria-label]="isExpanded(i) ? 'Show abbreviated paragraph' : 'Show full paragraph'">
                    <mat-icon>{{ isExpanded(i) ? 'unfold_less' : 'unfold_more' }}</mat-icon>
                  </button>
                }
              </div>
            }
          </div>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button [mat-dialog-close]="undefined">Cancel</button>
        <button mat-flat-button color="primary" [disabled]="targetLoading()" (click)="confirmExisting()">
          Move text here
        </button>
      </mat-dialog-actions>
    }
  `,
  styles: `
    .selection-preview {
      font-style: italic;
      color: var(--mat-sys-on-surface-variant, #666);
      border-left: 3px solid var(--mat-sys-primary, #673ab7);
      padding-left: 10px;
      margin: 4px 0 16px;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .spinner-wrap { display: flex; justify-content: center; padding: 24px 0; }
    .option-row {
      display: flex; align-items: center; gap: 10px;
      width: 100%; padding: 10px 12px; margin-bottom: 4px;
      border: 1px solid var(--mat-sys-outline-variant, #ccc); border-radius: 8px;
      background: none; cursor: pointer; text-align: left;
      font: inherit; color: inherit;
    }
    .option-row:hover { background: rgba(0, 0, 0, 0.05); }
    .option-row.selected { border-color: var(--mat-sys-primary, #673ab7); }
    .option-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chevron { margin-left: auto; opacity: 0.5; }
    .title-field { width: 100%; margin: 4px 0 8px; }
    .list-label {
      font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--mat-sys-on-surface-variant, #666); margin: 12px 0 6px;
    }
    .empty-note { color: var(--mat-sys-on-surface-variant, #666); padding: 8px 0; }
    .position-title { display: flex; align-items: center; gap: 4px; }
    .position-toggle { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
    .toggle-btn {
      padding: 6px 14px; border-radius: 16px;
      border: 1px solid var(--mat-sys-outline-variant, #ccc);
      background: none; cursor: pointer; font: inherit; color: inherit;
    }
    .toggle-btn.selected {
      background: var(--mat-sys-primary, #673ab7);
      border-color: var(--mat-sys-primary, #673ab7);
      color: var(--mat-sys-on-primary, #fff);
    }
    .toggle-label { color: var(--mat-sys-on-surface-variant, #666); }
    .para-list { display: flex; flex-direction: column; gap: 6px; }
    .para-row {
      display: flex; align-items: flex-start; gap: 4px;
      border: 1px solid var(--mat-sys-outline-variant, #ccc); border-radius: 8px;
    }
    .para-row.selected {
      border-color: var(--mat-sys-primary, #673ab7);
      background: rgba(103, 58, 183, 0.06);
    }
    .para-text {
      flex: 1; padding: 8px 10px; background: none; border: none;
      cursor: pointer; text-align: left; font: inherit; color: inherit;
      line-height: 1.45;
    }
    .expand-btn { margin: 2px 2px 0 0; flex-shrink: 0; }
  `,
})
export class MoveTextDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<MoveTextDialogComponent, MoveTextDialogResult>);
  private readonly chapterService = inject(ChapterService);
  readonly data: MoveTextDialogData = inject(MAT_DIALOG_DATA);

  readonly abbreviateThreshold = ABBREVIATE_THRESHOLD;
  readonly preview = this.data.selectionPreview.replace(/\s+/g, ' ').trim();

  readonly step = signal<'target' | 'position'>('target');
  readonly loading = signal(true);
  private readonly chapters = signal<Chapter[]>([]);
  readonly targets = computed(() =>
    this.chapters()
      .filter(c => c.id !== this.data.currentChapterId)
      .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)),
  );

  readonly newChapterMode = signal(false);
  readonly newTitle = signal('');

  readonly targetChapter = signal<Chapter | null>(null);
  readonly targetLoading = signal(false);
  readonly paragraphs = signal<ContentBlock[]>([]);
  readonly selectedIndex = signal(-1);
  readonly position = signal<'before' | 'after'>('after');
  private readonly expanded = signal<ReadonlySet<number>>(new Set());

  ngOnInit(): void {
    this.chapterService.getByBook(this.data.bookId).subscribe({
      next: chapters => { this.chapters.set(chapters); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  startNewChapter(): void {
    this.newChapterMode.set(true);
  }

  confirmNew(): void {
    const title = this.newTitle().trim();
    if (!title) return;
    this.dialogRef.close({ mode: 'new', title, sortOrder: this.chapters().length });
  }

  chooseExisting(chapter: Chapter): void {
    this.step.set('position');
    this.targetLoading.set(true);
    this.expanded.set(new Set());
    // Refetch for up-to-date content — the list endpoint may be stale.
    this.chapterService.getById(chapter.id).subscribe({
      next: full => {
        this.targetChapter.set(full);
        const paras = parseContentBlocks(full.content ?? '');
        this.paragraphs.set(paras);
        this.selectedIndex.set(paras.length - 1);
        this.position.set('after');
        this.targetLoading.set(false);
      },
      error: () => {
        this.targetLoading.set(false);
        this.backToTargets();
      },
    });
  }

  backToTargets(): void {
    this.step.set('target');
    this.targetChapter.set(null);
    this.paragraphs.set([]);
  }

  confirmExisting(): void {
    const chapter = this.targetChapter();
    if (!chapter) return;
    this.dialogRef.close({
      mode: 'existing',
      chapter,
      anchor: this.paragraphs()[this.selectedIndex()]?.anchor ?? null,
      position: this.position(),
    });
  }

  isExpanded(index: number): boolean {
    return this.expanded().has(index);
  }

  toggleExpanded(index: number): void {
    this.expanded.update(set => {
      const next = new Set(set);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  abbreviate(text: string): string {
    if (text.length <= ABBREVIATE_THRESHOLD) return text;
    return `${text.slice(0, 90).trimEnd()} … ${text.slice(-60).trimStart()}`;
  }
}
