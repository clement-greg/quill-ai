import {
  Component, inject, signal, computed, OnInit, OnDestroy,
  ElementRef, ViewChild, HostListener, effect, untracked,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ChapterService } from '../chapter/chapter.service';
import { ChapterDraftService } from './chapter-draft.service';
import { ChapterVersionService } from './chapter-version.service';
import { Chapter, ChapterNote, ChapterVersion } from '@shared/models/chapter.model';
import { Entity } from '@shared/models/entity.model';
import { EntityQuote } from '@shared/models';
import { BookService } from '../book/book.service';
import { EntityService } from '../services/entity.service';
import { EntityQuoteService } from '../services/entity-quote.service';
import { SeriesService } from '../series/series.service';
import { SlideOutPanelContainer } from '../shared/slide-out-panel-container/slide-out-panel-container';
import { EntityEditComponent } from '../entity-edit/entity-edit';
import { RichTextEditorComponent, SuggestedEntityCard } from '../shared/rich-text-editor/rich-text-editor';
import { HeaderService } from '../services/header.service';
import { EntityPanelService } from '../services/entity-panel.service';
import { UserSettingsService } from '../services/user-settings.service';
import { SeriesContextService } from '../services/series-context.service';

@Component({
  selector: 'app-chapter-edit',
  imports: [
    FormsModule,
    MatButtonModule, MatIconModule, MatInputModule, MatFormFieldModule,
    MatProgressSpinnerModule, MatTabsModule, MatDialogModule, MatMenuModule,
    SlideOutPanelContainer, EntityEditComponent, RichTextEditorComponent,
  ],
  templateUrl: './chapter-edit.html',
  styleUrl: './chapter-edit.scss',
})
export class ChapterEditComponent implements OnInit, OnDestroy {
  @ViewChild(RichTextEditorComponent) editorRef!: RichTextEditorComponent;
  @ViewChild('noteInputEl') noteInputEl!: ElementRef<HTMLTextAreaElement>;

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private chapterService = inject(ChapterService);
  private draftService = inject(ChapterDraftService);
  private chapterVersionService = inject(ChapterVersionService);
  private entityService = inject(EntityService);
  private entityQuoteService = inject(EntityQuoteService);
  private bookService = inject(BookService);
  private seriesService = inject(SeriesService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private headerService = inject(HeaderService);
  private entityPanel = inject(EntityPanelService);
  private userSettings = inject(UserSettingsService);
  private seriesContext = inject(SeriesContextService);

  // ── Chapter state ────────────────────────────────────────────────────────
  chapter = signal<Chapter | null>(null);
  saving = signal(false);
  hasDraft = signal(false);
  entities = signal<Entity[]>([]);
  seriesId = signal('');

  // Computed AI endpoint for the editor
  aiEndpoint = computed(() => {
    const ch = this.chapter();
    return ch ? `/api/chat/${ch.id}` : '/api/chat/general';
  });

  // ── Entity quotes ────────────────────────────────────────────────────────
  capturingQuote = signal(false);

  // ── Notes (in-text annotation) ───────────────────────────────────────────
  notes = signal<ChapterNote[]>([]);
  noteInputVisible = signal(false);
  noteInputTop = signal(0);
  noteInputLeft = signal(0);
  noteInputText = signal('');
  highlightedNoteId = signal<string | null>(null);
  private noteSelectionRange: Range | null = null;

  // ── Version history ──────────────────────────────────────────────────────
  historyLoading = signal(false);
  historyVersions = signal<ChapterVersion[]>([]);
  selectedVersion = signal<ChapterVersion | null>(null);
  diffLines = signal<{ type: 'same' | 'add' | 'remove'; text: string }[]>([]);

  // ── Entity editing slide-out ─────────────────────────────────────────────
  editingEntity = signal<Entity | null>(null);

  // ── Entity suggestions (from editor grammar check) ───────────────────────
  pendingSuggestions = signal<SuggestedEntityCard[]>([]);
  private suggestedEntityNames = new Set<string>();

  // ── Sidebar ──────────────────────────────────────────────────────────────
  mobileSidebarOpen = signal(false);
  sidebarTabIndex = signal(0);
  sidebarWidth = signal(350);

  private resizerDrag: {
    startX: number; startWidth: number;
    moveHandler: (e: MouseEvent) => void; upHandler: () => void;
  } | null = null;

  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Extra ctx menu items passed to the editor ────────────────────────────
  readonly ctxMenuExtraItems: { id: string; label: string; icon: string }[] = [
    { id: 'capture-quote', label: 'Capture quote', icon: 'record_voice_over' },
    { id: 'capture-narrator-quote', label: 'Capture Narrator Quote', icon: 'menu_book' },
  ];

  constructor() {
    // Sync entity reference text when entity panel updates an entity
    effect(() => {
      const updated = this.entityPanel.lastUpdatedEntity();
      if (!updated) return;
      untracked(() => {
        this.entities.update(list => list.map(e => e.id === updated.id ? updated : e));
      });
    });

    // Auto-load version history when history tab becomes active
    effect(() => {
      const idx = this.sidebarTabIndex();
      const chapter = this.chapter();
      if (idx === 2 && chapter) {
        untracked(() => {
          if (!this.historyLoading() && this.historyVersions().length === 0) {
            this.loadHistory(chapter.id);
          }
        });
      }
    });
  }

  ngOnInit(): void {
    this.loadSidebarWidth();
    const id = this.route.snapshot.paramMap.get('id')!;

    this.chapterService.getById(id).subscribe({
      next: async (data) => {
        const draft = await this.draftService.getDraft(data.id);
        const hasDraft = draft !== null && draft.content !== (data.content ?? '');
        const content = hasDraft ? draft!.content : (data.content ?? '');
        const notes = hasDraft ? draft!.notes : (data.notes ?? []);
        if (hasDraft) this.hasDraft.set(true);
        this.chapter.set({ ...data, content });
        this.notes.set(notes);

        // Set editor content after view init (setTimeout ensures ViewChild is ready)
        setTimeout(() => {
          if (this.editorRef) this.editorRef.setContent(content);
        });

        this.bookService.getById(data.bookId).subscribe({
          next: (book) => {
            this.seriesId.set(book.seriesId);
            this.seriesContext.set(book.seriesId);

            this.seriesService.getById(book.seriesId).subscribe({
              next: (series) => {
                this.headerService.set(
                  [
                    { label: series.title, link: '/series/' + series.id },
                    { label: book.title, link: '/books/' + book.id },
                    { label: data.title || 'Chapter' },
                  ],
                  [
                    { icon: 'people', label: 'Entities', action: () => this.entityPanel.open(series.id) },
                    { icon: 'account_tree', label: 'Relationships', action: () => this.router.navigate(['/series', series.id, 'relationships']) },
                  ],
                );
              },
            });

            this.entityService.getBySeries(book.seriesId).subscribe({
              next: (entities) => {
                this.entities.set(entities.filter(e => !e.deleted && !e.archived));
              },
            });
          },
        });
      },
    });
  }

  ngOnDestroy(): void {
    this.headerService.clear();
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    if (this.resizerDrag) {
      document.removeEventListener('mousemove', this.resizerDrag.moveHandler);
      document.removeEventListener('mouseup', this.resizerDrag.upHandler);
    }
  }

  // ── Editor event handlers ────────────────────────────────────────────────

  onEditorContentChange(html: string): void {
    const current = this.chapter();
    if (!current) return;
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      this.draftService.saveDraft(current.id, html, this.notes());
      this.hasDraft.set(true);
      this.autoSaveTimer = null;
    }, 800);
  }

  onEntityEditRequest(entity: Entity): void {
    this.editingEntity.set(entity);
  }

  onEditorPendingSuggestionsChange(suggestions: SuggestedEntityCard[]): void {
    const existingNames = new Set(this.entities().map(e => e.name.toLowerCase()));
    const filtered = suggestions.filter(s =>
      s.created || s.creating || !existingNames.has(s.name.toLowerCase()),
    );
    const newOnes = filtered.filter(s =>
      !s.created && !s.creating && !this.suggestedEntityNames.has(s.name.toLowerCase()),
    );
    if (newOnes.length > 0) {
      this.activateSidebarTab(1);
      newOnes.forEach(s => this.suggestedEntityNames.add(s.name.toLowerCase()));
    }
    this.pendingSuggestions.set(filtered);
  }

  onEditorCtxMenuAction(event: { id: string; captureText: string; narratorCaptureText: string; surroundingText: string }): void {
    if (event.id === 'capture-quote') {
      this.captureQuote(event.captureText, event.surroundingText);
    } else if (event.id === 'capture-narrator-quote') {
      this.captureNarratorQuote(event.narratorCaptureText);
    }
  }

  onNoteRequest(): void {
    // Capture current selection rect to position the note input popup
    const rect = this.editorRef?.getSelectionRect();
    if (!rect || rect.width === 0) return;

    // Save the selection range so we can use it for wrapping
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    this.noteSelectionRange = sel.getRangeAt(0).cloneRange();

    const PANEL_WIDTH = 320;
    const top = rect.bottom + 10;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - PANEL_WIDTH / 2, window.innerWidth - PANEL_WIDTH - 8));
    this.noteInputTop.set(top);
    this.noteInputLeft.set(left);
    this.noteInputText.set('');
    this.noteInputVisible.set(true);

    setTimeout(() => this.noteInputEl?.nativeElement?.focus());
  }

  // ── Title / save ─────────────────────────────────────────────────────────

  updateTitle(value: string): void {
    const current = this.chapter();
    if (current) this.chapter.set({ ...current, title: value });
  }

  async save(): Promise<void> {
    const chapter = this.chapter();
    if (!chapter || !chapter.title.trim()) return;

    if (this.autoSaveTimer) { clearTimeout(this.autoSaveTimer); this.autoSaveTimer = null; }

    // Strip entity-quote spans before saving
    if (this.editorRef) this.editorRef.unwrapEntityQuotes();
    const content = this.editorRef?.getContent() ?? chapter.content ?? '';

    this.saving.set(true);
    const toSave = { ...chapter, content, notes: this.notes() };

    this.chapterService.update(toSave).subscribe({
      next: async () => {
        this.chapterVersionService.create(
          chapter.id, content,
          this.userSettings.displayName() || undefined,
          this.userSettings.avatarUrl() || undefined,
        ).subscribe();

        if (this.historyVersions().length > 0) this.loadHistory(chapter.id);
        await this.draftService.clearDraft(chapter.id);
        this.hasDraft.set(false);
        this.saving.set(false);
        this.snackBar.open('Chapter saved', undefined, { duration: 3000 });
      },
      error: () => this.saving.set(false),
    });
  }

  discardDraft(): void {
    const chapter = this.chapter();
    if (!chapter) return;
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: { title: 'Discard draft?', message: 'This will revert to the last saved version. Any unsaved changes will be lost.', confirm: 'Discard' },
      width: '360px',
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.draftService.clearDraft(chapter.id);
      this.hasDraft.set(false);
      this.chapterService.getById(chapter.id).subscribe({
        next: (data) => {
          this.chapter.set(data);
          this.notes.set(data.notes ?? []);
          this.editorRef?.setContent(data.content ?? '');
        },
      });
    });
  }

  // ── Notes (in-text) ──────────────────────────────────────────────────────

  submitNote(): void {
    const text = this.noteInputText().trim();
    if (!text) return;

    const noteId = crypto.randomUUID();

    // Restore selection in editor then wrap
    const sel = window.getSelection();
    const editor = this.editorRef?.getEditorElement();
    if (sel && this.noteSelectionRange && editor) {
      sel.removeAllRanges();
      sel.addRange(this.noteSelectionRange);
    }

    const selectedText = this.editorRef?.wrapSelectionWithNote(noteId) ?? '';

    const note: ChapterNote = {
      id: noteId,
      noteText: text,
      selectedText,
      createdAt: new Date().toISOString(),
      createdByName: this.userSettings.displayName() || undefined,
      createdByAvatar: this.userSettings.avatarUrl() || undefined,
    };
    this.notes.update(ns => [...ns, note]);

    const current = this.chapter();
    if (current) {
      const content = this.editorRef?.getContent() ?? '';
      if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = setTimeout(() => {
        this.draftService.saveDraft(current.id, content, this.notes());
        this.hasDraft.set(true);
      }, 800);
    }

    this.dismissNoteInput();
  }

  dismissNoteInput(): void {
    this.noteInputVisible.set(false);
    this.noteInputText.set('');
    this.noteSelectionRange = null;
  }

  onNoteInputKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.dismissNoteInput();
    else if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); this.submitNote(); }
  }

  deleteNote(noteId: string): void {
    this.notes.update(ns => ns.filter(n => n.id !== noteId));
    this.editorRef?.removeNoteSpan(noteId);
    const current = this.chapter();
    if (current) {
      const content = this.editorRef?.getContent() ?? '';
      if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = setTimeout(() => {
        this.draftService.saveDraft(current.id, content, this.notes());
        this.hasDraft.set(true);
      }, 800);
    }
  }

  scrollToNote(noteId: string): void {
    this.highlightedNoteId.set(noteId);
    this.editorRef?.scrollToNoteSpan(noteId);
    setTimeout(() => this.highlightedNoteId.set(null), 2100);
  }

  toggleNotesList(): void { this.activateSidebarTab(0); }

  // ── Quote capture ────────────────────────────────────────────────────────

  captureQuote(quoteText: string, surroundingContext: string): void {
    const chapter = this.chapter();
    if (!quoteText || !chapter || this.capturingQuote()) return;
    this.capturingQuote.set(true);
    this.entityQuoteService.capture(chapter.id, quoteText, surroundingContext).subscribe({
      next: ({ entityName }) => {
        this.snackBar.open(`Quote captured for ${entityName}`, undefined, { duration: 3000 });
        this.capturingQuote.set(false);
      },
      error: (err: { error?: { error?: string } }) => {
        const msg = err?.error?.error ?? 'Could not identify speaker';
        this.snackBar.open(`Failed: ${msg}`, undefined, { duration: 4000 });
        this.capturingQuote.set(false);
      },
    });
  }

  captureNarratorQuote(text: string): void {
    if (!text || !this.seriesId() || this.capturingQuote()) return;
    this.capturingQuote.set(true);
    this.entityService.getOrCreateNarrator(this.seriesId()).subscribe({
      next: (narrator) => {
        this.entityQuoteService.create(narrator.id, text).subscribe({
          next: () => {
            this.snackBar.open('Narrator quote captured', undefined, { duration: 3000 });
            this.capturingQuote.set(false);
          },
          error: () => {
            this.snackBar.open('Failed to capture narrator quote', undefined, { duration: 4000 });
            this.capturingQuote.set(false);
          },
        });
      },
      error: () => {
        this.snackBar.open('Failed to find narrator', undefined, { duration: 4000 });
        this.capturingQuote.set(false);
      },
    });
  }

  // ── Entity suggestions ───────────────────────────────────────────────────

  openSuggestionInlineEdit(index: number): void {
    const card = this.pendingSuggestions()[index];
    if (!card) return;
    const draft: Entity = {
      id: crypto.randomUUID(),
      name: card.name,
      type: card.type,
      seriesId: this.seriesId(),
      biography: card.description,
      ...(card.firstName ? { firstName: card.firstName } : {}),
      ...(card.lastName ? { lastName: card.lastName } : {}),
      ...(card.nickname ? { nickname: card.nickname } : {}),
      ...(card.title ? { title: card.title } : {}),
    } as Entity;
    this.pendingSuggestions.update(list =>
      list.map((c, i) => i === index ? { ...c, creating: true, draftEntity: draft } : c),
    );
  }

  cancelSuggestionInlineEdit(index: number): void {
    this.pendingSuggestions.update(list =>
      list.map((c, i) => i === index ? { ...c, creating: false, draftEntity: undefined } : c),
    );
  }

  acceptSuggestedEntity(index: number, entity: Entity): void {
    this.entityService.create(entity).subscribe({
      next: (created) => {
        this.entities.update(list => [...list, created]);
        this.pendingSuggestions.update(list =>
          list.map((c, i) => i === index ? { ...c, creating: false, created: true } : c),
        );
        this.editorRef?.wrapNewEntity(created);
      },
    });
  }

  dismissSuggestion(index: number): void {
    this.pendingSuggestions.update(list => list.filter((_, i) => i !== index));
  }

  // ── Entity edit slide-out ────────────────────────────────────────────────

  saveEntityEdit(entity: Entity): void {
    this.entityService.update(entity).subscribe({
      next: (updated) => {
        this.entities.update(list => list.map(e => e.id === updated.id ? updated : e));
        this.editingEntity.set(null);
      },
    });
  }

  archiveEntityEdit(id: string): void {
    this.entityService.archive(id).subscribe({
      next: () => {
        this.entities.update(list => list.filter(e => e.id !== id));
        this.editingEntity.set(null);
      },
    });
  }

  cancelEntityEdit(): void { this.editingEntity.set(null); }

  // ── Version history ──────────────────────────────────────────────────────

  loadHistory(chapterId: string): void {
    this.historyLoading.set(true);
    this.chapterVersionService.getByChapter(chapterId).subscribe({
      next: (versions) => { this.historyVersions.set(versions); this.historyLoading.set(false); },
      error: () => this.historyLoading.set(false),
    });
  }

  selectVersion(version: ChapterVersion): void {
    this.selectedVersion.set(version);
    const oldText = this.stripHtml(version.content);
    const newText = this.stripHtml(this.editorRef?.getContent() ?? '');
    this.diffLines.set(this.computeDiff(oldText, newText));
  }

  formatVersionDate(savedAt: string): string {
    return new Date(savedAt).toLocaleString();
  }

  private stripHtml(html: string): string {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.innerText || div.textContent || '').trim();
  }

  private computeDiff(oldText: string, newText: string): { type: 'same' | 'add' | 'remove'; text: string }[] {
    const a = oldText.split('\n');
    const b = newText.split('\n');
    const m = a.length, n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const result: { type: 'same' | 'add' | 'remove'; text: string }[] = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { result.push({ type: 'same', text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push({ type: 'remove', text: a[i] }); i++; }
      else { result.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < m) result.push({ type: 'remove', text: a[i++] });
    while (j < n) result.push({ type: 'add', text: b[j++] });
    return result;
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────

  onSidebarTabChange(index: number): void {
    this.sidebarTabIndex.set(index);
    if (index === 2) {
      const chapter = this.chapter();
      if (chapter && !this.historyLoading() && this.historyVersions().length === 0) this.loadHistory(chapter.id);
    }
  }

  activateSidebarTab(index: number): void {
    if (this.mobileSidebarOpen() && this.sidebarTabIndex() === index) this.mobileSidebarOpen.set(false);
    else { this.onSidebarTabChange(index); this.mobileSidebarOpen.set(true); }
  }

  private static readonly SIDEBAR_STORAGE_KEY = 'chapter-edit-sidebar-width';
  private static readonly SIDEBAR_MIN = 200;
  private static readonly SIDEBAR_MAX_RATIO = 0.6;

  private loadSidebarWidth(): void {
    const stored = localStorage.getItem(ChapterEditComponent.SIDEBAR_STORAGE_KEY);
    if (stored) {
      const w = parseInt(stored, 10);
      if (!isNaN(w) && w >= ChapterEditComponent.SIDEBAR_MIN && w < window.innerWidth * ChapterEditComponent.SIDEBAR_MAX_RATIO) {
        this.sidebarWidth.set(w);
      }
    }
  }

  onResizerMouseDown(event: MouseEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.sidebarWidth();
    const moveHandler = (e: MouseEvent) => {
      const maxWidth = window.innerWidth * ChapterEditComponent.SIDEBAR_MAX_RATIO;
      const delta = startX - e.clientX;
      this.sidebarWidth.set(Math.round(Math.max(ChapterEditComponent.SIDEBAR_MIN, Math.min(startWidth + delta, maxWidth))));
    };
    const upHandler = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(ChapterEditComponent.SIDEBAR_STORAGE_KEY, String(this.sidebarWidth()));
      this.resizerDrag = null;
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
    this.resizerDrag = { startX, startWidth, moveHandler, upHandler };
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    if (this.noteInputVisible() && !(event.target as HTMLElement).closest('.note-input-popup')) {
      this.dismissNoteInput();
    }
  }

  // ── Misc ─────────────────────────────────────────────────────────────────

  goBack(): void {
    const chapter = this.chapter();
    if (chapter?.bookId) this.router.navigate(['/books', chapter.bookId]);
    else this.router.navigate(['/series']);
  }
}

@Component({
  selector: 'app-confirm-dialog',
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>{{ data.message }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button color="warn" [mat-dialog-close]="true">{{ data.confirm }}</button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialogComponent {
  data = inject<{ title: string; message: string; confirm: string }>(MAT_DIALOG_DATA);
}
