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
import { Chapter, ChapterNote, ChapterVersion, OutlineItem } from '@shared/models/chapter.model';
import { Entity } from '@shared/models/entity.model';
import { EntityQuote } from '@shared/models';
import { BookService } from '../book/book.service';
import { EntityService } from '../services/entity.service';
import { EntityQuoteService } from '../services/entity-quote.service';
import { TimelineEventService } from '../services/timeline-event.service';
import { ChapterAnalysisDialogComponent, ChapterAnalysisDialogData, ChapterAnalysisDialogResult } from './chapter-analysis-dialog';
import { EntityRelationshipService } from '../services/entity-relationship.service';
import { SeriesService } from '../series/series.service';
import { SlideOutPanelContainer } from '../shared/slide-out-panel-container/slide-out-panel-container';
import { EntityEditComponent } from '../entity-edit/entity-edit';
import { RichTextEditorComponent, SuggestedEntityCard } from '../shared/rich-text-editor/rich-text-editor';
import { AiStatsComponent } from '../book-detail/ai-stats/ai-stats';
import { ChapterOutlineComponent } from './chapter-outline/chapter-outline';
import { HeaderService } from '../services/header.service';
import { UserSettingsService } from '../services/user-settings.service';
import { AuthService } from '../auth/auth.service';
import { SeriesContextService } from '../services/series-context.service';
import { EditorBridgeService } from '../services/editor-bridge.service';
import { RecentChaptersService } from '../services/recent-chapters.service';
import { diffWords } from 'diff';
import { forkJoin, Subscription } from 'rxjs';

interface DiffWord { type: 'same' | 'add' | 'remove'; text: string; }
interface DiffParagraph { hasChanges: boolean; segments: DiffWord[]; }

@Component({
  selector: 'app-chapter-edit',
  imports: [
    FormsModule,
    MatButtonModule, MatIconModule, MatInputModule, MatFormFieldModule,
    MatProgressSpinnerModule, MatTabsModule, MatDialogModule, MatMenuModule,
    SlideOutPanelContainer, EntityEditComponent, RichTextEditorComponent, AiStatsComponent, ChapterOutlineComponent,
  ],
  templateUrl: './chapter-edit.html',
  styleUrl: './chapter-edit.scss',
})
export class ChapterEditComponent implements OnInit, OnDestroy {
  @ViewChild(RichTextEditorComponent) editorRef!: RichTextEditorComponent;
  @ViewChild('noteInputEl') noteInputEl!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('searchInputEl') searchInputEl?: ElementRef<HTMLInputElement>;

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private chapterService = inject(ChapterService);
  private draftService = inject(ChapterDraftService);
  private chapterVersionService = inject(ChapterVersionService);
  private entityService = inject(EntityService);
  private entityQuoteService = inject(EntityQuoteService);
  private timelineEventService = inject(TimelineEventService);
  private entityRelationshipService = inject(EntityRelationshipService);
  private bookService = inject(BookService);
  private seriesService = inject(SeriesService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private headerService = inject(HeaderService);
  private userSettings = inject(UserSettingsService);
  private authService = inject(AuthService);
  private seriesContext = inject(SeriesContextService);
  private editorBridge = inject(EditorBridgeService);
  private recentChapters = inject(RecentChaptersService);
  private routeSub?: Subscription;

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

  // ── Chapter analysis (timeline + relationships) ──────────────────────────
  analyzingChapter = signal(false);

  // ── Outline ──────────────────────────────────────────────────────────────
  outline = signal<OutlineItem[]>([]);

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
  previousVersion = signal<ChapterVersion | null>(null);
  diffLines = signal<DiffParagraph[]>([]);
  historyListHeight = signal(180);

  // ── Chapter image ──────────────────────────────────────────────────────
  imageUrl = signal<string | null>(null);
  imageThumbnailUrl = signal<string | null>(null);
  imageUploading = signal(false);

  // ── Entity editing slide-out ─────────────────────────────────────────────
  editingEntity = signal<Entity | null>(null);

  // ── AI stats slide-out ───────────────────────────────────────────────────
  showAiStats = signal(false);

  // ── Entity suggestions (from editor grammar check) ───────────────────────
  pendingSuggestions = signal<SuggestedEntityCard[]>([]);
  private suggestedEntityNames = new Set<string>();
  private dismissedEntityNames = new Set<string>();

  // ── Find-in-page search ──────────────────────────────────────────────────
  searchVisible = signal(false);
  searchQuery = signal('');
  searchMatchCount = signal(0);
  searchMatchIndex = signal(0); // 0-based

  // ── Sidebar ──────────────────────────────────────────────────────────────
  mobileSidebarOpen = signal(false);
  sidebarTabIndex = signal(0);
  sidebarWidth = signal(350);

  // Track emails whose avatar endpoint returned an error so we fall back to the placeholder icon
  private _avatarErrors = signal<ReadonlySet<string>>(new Set());
  avatarFailed(email: string): boolean { return this._avatarErrors().has(email); }
  onAvatarError(email: string): void { this._avatarErrors.update(s => new Set([...s, email])); }

  private onDocumentKeyDown = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && this.chapter()) {
      e.preventDefault();
      this.openSearch();
    } else if (e.key === 'Escape' && this.searchVisible()) {
      this.closeSearch();
    }
  };

  private resizerDrag: {
    startX: number; startWidth: number;
    moveHandler: (e: MouseEvent) => void; upHandler: () => void;
  } | null = null;

  private historyResizerDrag: {
    startY: number; startHeight: number;
    moveHandler: (e: MouseEvent) => void; upHandler: () => void;
  } | null = null;

  private static readonly HISTORY_LIST_HEIGHT_KEY = 'chapter-edit-history-list-height';
  private static readonly HISTORY_LIST_MIN = 80;
  private static readonly HISTORY_LIST_MAX = 400;

  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicSaveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly PERIODIC_SAVE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  /** Content as of the last successful server save — used to skip auto-saves when nothing changed. */
  private lastSavedContent: string | null = null;

  // ── Extra ctx menu items passed to the editor ────────────────────────────
  readonly ctxMenuExtraItems: { id: string; label: string; icon: string }[] = [
    { id: 'capture-quote', label: 'Capture quote', icon: 'record_voice_over' },
    { id: 'capture-narrator-quote', label: 'Capture Narrator Quote', icon: 'menu_book' },
  ];

  constructor() {
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

    // Start/stop the periodic server auto-save based on the user setting
    effect(() => {
      const enabled = this.userSettings.autoSaveEnabled();
      const chapter = this.chapter();
      untracked(() => {
        this.stopPeriodicSave();
        if (enabled && chapter) {
          this.startPeriodicSave();
        }
      });
    });
  }

  ngOnInit(): void {
    document.addEventListener('keydown', this.onDocumentKeyDown);
    this.loadSidebarWidth();
    this.loadHistoryListHeight();

    this.routeSub = this.route.paramMap.subscribe(params => {
      const id = params.get('id')!;
      this.chapter.set(null);
      this.hasDraft.set(false);
      this.notes.set([]);
      this.outline.set([]);
      this.lastSavedContent = null;

      this.chapterService.getById(id).subscribe({
      next: async (data) => {
        const draft = await this.draftService.getDraft(data.id);
        const contentDiffers = draft !== null && draft.content !== (data.content ?? '');
        const outlineDiffers = draft !== null && JSON.stringify(draft.outline ?? []) !== JSON.stringify(data.outline ?? []);
        const hasDraft = contentDiffers || outlineDiffers;
        const content = hasDraft ? draft!.content : (data.content ?? '');
        const notes = hasDraft ? draft!.notes : (data.notes ?? []);
        const outline = draft !== null ? (draft.outline ?? data.outline ?? []) : (data.outline ?? []);
        if (hasDraft) this.hasDraft.set(true);
        this.chapter.set({ ...data, content });
        this.notes.set(notes);
        this.outline.set(outline);
        this.imageUrl.set(data.imageUrl ?? null);
        this.imageThumbnailUrl.set(data.imageThumbnailUrl ?? null);
        this.lastSavedContent = data.content ?? '';

        // Set editor content after view init (setTimeout ensures ViewChild is ready)
        setTimeout(() => {
          if (this.editorRef) {
            this.editorRef.setContent(content);
            this.editorBridge.register(this.editorRef);
          }
        });

        this.bookService.getById(data.bookId).subscribe({
          next: (book) => {
            this.seriesId.set(book.seriesId);
            this.seriesContext.set(book.seriesId);

            forkJoin({
              series: this.seriesService.getById(book.seriesId),
              allSeries: this.seriesService.getAll(),
              booksInSeries: this.bookService.getBySeries(book.seriesId),
              chaptersInBook: this.chapterService.getByBook(data.bookId),
            }).subscribe({
              next: ({ series, allSeries, booksInSeries, chaptersInBook }) => {
                const thumbFilename = data.imageThumbnailUrl?.split('/').pop();
                this.recentChapters.record({
                  chapterId: data.id,
                  chapterTitle: data.title || 'Chapter',
                  bookTitle: book.title,
                  seriesTitle: series.title,
                  thumbnailUrl: thumbFilename ? `/api/image/${thumbFilename}` : undefined,
                });
                const filteredSeries = allSeries.filter(s => !s.archived && !s.deleted);
                const filteredBooks = booksInSeries.filter(b => !b.archived && !b.deleted)
                  .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
                const sortedChapters = [...chaptersInBook]
                  .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
                this.headerService.set([
                  {
                    label: series.title,
                    link: '/series/' + series.id,
                    dropdownItems: filteredSeries.map(s => ({ label: s.title, link: '/series/' + s.id, isCurrent: s.id === series.id })),
                  },
                  {
                    label: book.title,
                    link: '/books/' + book.id,
                    dropdownItems: filteredBooks.map(b => ({ label: b.title, link: '/books/' + b.id, isCurrent: b.id === book.id })),
                  },
                  {
                    label: data.title || 'Chapter',
                    dropdownItems: sortedChapters.map(c => ({ label: c.title || 'Chapter', link: '/chapters/' + c.id + '/edit', isCurrent: c.id === data.id })),
                  },
                ]);
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
    });
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.onDocumentKeyDown);
    this.editorBridge.unregister();
    this.routeSub?.unsubscribe();
    this.headerService.clear();
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.stopPeriodicSave();
    if (this.resizerDrag) {
      document.removeEventListener('mousemove', this.resizerDrag.moveHandler);
      document.removeEventListener('mouseup', this.resizerDrag.upHandler);
    }
    if (this.historyResizerDrag) {
      document.removeEventListener('mousemove', this.historyResizerDrag.moveHandler);
      document.removeEventListener('mouseup', this.historyResizerDrag.upHandler);
    }
  }

  // ── Editor event handlers ────────────────────────────────────────────────

  private startPeriodicSave(): void {
    if (this.periodicSaveTimer) return;
    this.periodicSaveTimer = setInterval(() => {
      const currentContent = this.editorRef?.getContent() ?? '';
      if (!this.saving() && this.lastSavedContent !== null && currentContent !== this.lastSavedContent) {
        this.save();
      }
    }, ChapterEditComponent.PERIODIC_SAVE_INTERVAL_MS);
  }

  private stopPeriodicSave(): void {
    if (this.periodicSaveTimer) {
      clearInterval(this.periodicSaveTimer);
      this.periodicSaveTimer = null;
    }
  }

  private scheduleDraftSave(html?: string): void {
    const current = this.chapter();
    if (!current) return;
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      const content = html ?? this.editorRef?.getContent() ?? '';
      this.draftService.saveDraft(current.id, content, this.notes(), this.outline());
      this.hasDraft.set(true);
      this.autoSaveTimer = null;
    }, 800);
  }

  onEditorContentChange(html: string): void {
    if (!this.chapter()) return;
    if (this.searchVisible()) {
      this.searchMatchCount.set(0);
      this.searchMatchIndex.set(0);
      this.searchVisible.set(false);
      this.searchQuery.set('');
    }
    this.scheduleDraftSave(html);
  }

  onOutlineChange(items: OutlineItem[]): void {
    this.outline.set(items);
    this.scheduleDraftSave();
  }

  onEntityEditRequest(entity: Entity): void {
    this.editingEntity.set(entity);
  }

  onEditorPendingSuggestionsChange(suggestions: SuggestedEntityCard[]): void {
    const existingNames = new Set(this.entities().map(e => e.name.toLowerCase()));
    const filtered = suggestions.filter(s =>
      s.created || s.creating || (
        !existingNames.has(s.name.toLowerCase()) &&
        !this.dismissedEntityNames.has(s.name.toLowerCase())
      ),
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
    const PANEL_HEIGHT = 240; // estimated max height of the popup
    const rawTop = rect.bottom + 10;
    const top = Math.min(rawTop, window.innerHeight - PANEL_HEIGHT - 8);
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - PANEL_WIDTH / 2, window.innerWidth - PANEL_WIDTH - 8));
    this.noteInputTop.set(top);
    this.noteInputLeft.set(left);
    this.noteInputText.set('');
    this.noteInputVisible.set(true);

    setTimeout(() => this.noteInputEl?.nativeElement?.focus());
  }

  // ── Chapter image ──────────────────────────────────────────────────────

  onImageFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    this.imageUploading.set(true);
    this.chapterService.uploadImage(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        this.imageUrl.set(url);
        this.imageThumbnailUrl.set(thumbnailUrl);
        const current = this.chapter();
        if (!current) { this.imageUploading.set(false); return; }
        const updated = { ...current, imageUrl: url, imageThumbnailUrl: thumbnailUrl };
        this.chapter.set(updated);
        this.chapterService.update(updated).subscribe({
          next: () => {
            this.imageUploading.set(false);
            this.snackBar.open('Chapter image saved', undefined, { duration: 2500 });
          },
          error: () => {
            this.imageUploading.set(false);
            this.snackBar.open('Image uploaded but chapter save failed — click Save to retry', undefined, { duration: 4000 });
          },
        });
      },
      error: () => {
        this.snackBar.open('Image upload failed', undefined, { duration: 3000 });
        this.imageUploading.set(false);
      },
    });
  }

  removeChapterImage(): void {
    const current = this.chapter();
    if (!current) return;
    const updated = { ...current, imageUrl: undefined, imageThumbnailUrl: undefined };
    this.imageUrl.set(null);
    this.imageThumbnailUrl.set(null);
    this.chapter.set(updated);
    this.chapterService.update(updated).subscribe({
      error: () => this.snackBar.open('Failed to remove image — click Save to retry', undefined, { duration: 4000 }),
    });
  }

  proxyUrl(azureUrl: string | null): string | null {
    if (!azureUrl) return null;
    const filename = azureUrl.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
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
    const outline = this.outline().filter(item => item.text.trim() !== '');
    const toSave = { ...chapter, content, notes: this.notes(), outline };

    this.chapterService.update(toSave).subscribe({
      next: async () => {
        this.chapterVersionService.create(
          chapter.id, content,
          this.userSettings.displayName() || this.authService.currentUser()?.name || undefined,
        ).subscribe();

        if (this.historyVersions().length > 0) this.loadHistory(chapter.id);
        await this.draftService.clearDraft(chapter.id);
        this.hasDraft.set(false);
        this.lastSavedContent = content;
        this.saving.set(false);
        this.snackBar.open('Chapter saved', undefined, { duration: 3000 });
      },
      error: () => this.saving.set(false),
    });
  }

  archiveChapter(): void {
    const chapter = this.chapter();
    if (!chapter) return;
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: { title: 'Archive chapter?', message: 'This chapter will be moved to the archive and removed from the book. You can restore it later.', confirm: 'Archive' },
      width: '360px',
    });
    dialogRef.afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.chapterService.archive(chapter.id).subscribe({
        next: () => this.router.navigate(['/books', chapter.bookId]),
      });
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
          this.outline.set(data.outline ?? []);
          this.imageUrl.set(data.imageUrl ?? null);
          this.imageThumbnailUrl.set(data.imageThumbnailUrl ?? null);
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
      createdBy: this.authService.currentUser()?.email || undefined,
      createdByName: this.userSettings.displayName() || undefined,
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

  // ── Find-in-page search ──────────────────────────────────────────────────

  openSearch(): void {
    this.searchVisible.set(true);
    setTimeout(() => this.searchInputEl?.nativeElement?.focus());
  }

  closeSearch(): void {
    this.searchVisible.set(false);
    this.searchQuery.set('');
    this.searchMatchCount.set(0);
    this.searchMatchIndex.set(0);
    this.editorRef?.clearSearchHighlights();
    this.editorRef?.focus();
  }

  onSearchQueryChange(query: string): void {
    this.searchQuery.set(query);
    if (!query.trim()) {
      this.editorRef?.clearSearchHighlights();
      this.searchMatchCount.set(0);
      this.searchMatchIndex.set(0);
      return;
    }
    const count = this.editorRef?.highlightSearchMatches(query) ?? 0;
    this.searchMatchCount.set(count);
    const idx = count > 0 ? 0 : 0;
    this.searchMatchIndex.set(idx);
    if (count > 0) this.editorRef?.scrollToSearchMatch(idx);
  }

  onSearchKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) this.prevSearchMatch();
      else this.nextSearchMatch();
    } else if (event.key === 'Escape') {
      this.closeSearch();
    }
  }

  nextSearchMatch(): void {
    const count = this.searchMatchCount();
    if (count === 0) return;
    const next = (this.searchMatchIndex() + 1) % count;
    this.searchMatchIndex.set(next);
    this.editorRef?.scrollToSearchMatch(next);
  }

  prevSearchMatch(): void {
    const count = this.searchMatchCount();
    if (count === 0) return;
    const prev = (this.searchMatchIndex() - 1 + count) % count;
    this.searchMatchIndex.set(prev);
    this.editorRef?.scrollToSearchMatch(prev);
  }

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

  // ── Chapter analysis (timeline + relationships) ──────────────────────────

  analyzeChapter(): void {
    const chapter = this.chapter();
    if (!chapter || this.analyzingChapter()) return;
    const text = this.stripHtml(this.editorRef?.getContent() ?? chapter.content ?? '');
    if (!text.trim()) {
      this.snackBar.open('Chapter is empty — nothing to analyze', undefined, { duration: 3000 });
      return;
    }
    this.analyzingChapter.set(true);
    this.snackBar.open('Analyzing chapter…');
    forkJoin({
      timeline: this.timelineEventService.extractFromChapter(chapter.id, this.seriesId(), text),
      relationships: this.entityRelationshipService.extractFromChapter(chapter.id, this.seriesId(), text),
    }).subscribe({
      next: ({ timeline, relationships }) => {
        this.analyzingChapter.set(false);
        this.snackBar.dismiss();
        const totalProposals =
          timeline.adds.length + timeline.updates.length + timeline.removes.length +
          relationships.adds.length;
        if (totalProposals === 0) {
          this.snackBar.open('Nothing new found — everything is up to date', undefined, { duration: 4000 });
          return;
        }
        const ref = this.dialog.open(ChapterAnalysisDialogComponent, {
          data: { timeline: { ...timeline, entities: this.entities() }, relationships } satisfies ChapterAnalysisDialogData,
          autoFocus: false,
          maxHeight: '85vh',
        });
        ref.afterClosed().subscribe((selection?: ChapterAnalysisDialogResult) => {
          if (!selection) return;
          const { timeline: tl, relationships: rel } = selection;
          const hasTl = tl.adds.length + tl.updates.length + tl.removes.length > 0;
          const hasRel = rel.adds.length > 0;
          if (!hasTl && !hasRel) return;

          const pending: Promise<string>[] = [];

          if (hasTl) {
            pending.push(new Promise(resolve => {
              this.timelineEventService.applyChapterProposals({ chapterId: chapter.id, ...tl }).subscribe({
                next: ({ added, updated, removed }) => {
                  const parts: string[] = [];
                  if (added) parts.push(`${added} timeline added`);
                  if (updated) parts.push(`${updated} updated`);
                  if (removed) parts.push(`${removed} removed`);
                  resolve(parts.join(', '));
                },
                error: () => {
                  this.snackBar.open('Failed to apply timeline changes', undefined, { duration: 4000 });
                  resolve('');
                },
              });
            }));
          }

          if (hasRel) {
            pending.push(new Promise(resolve => {
              this.entityRelationshipService.applyChapterProposals({
                chapterId: chapter.id,
                seriesId: this.seriesId(),
                adds: rel.adds,
              }).subscribe({
                next: ({ added }) => resolve(`${added} relationship${added === 1 ? '' : 's'} added`),
                error: () => {
                  this.snackBar.open('Failed to apply relationship changes', undefined, { duration: 4000 });
                  resolve('');
                },
              });
            }));
          }

          Promise.all(pending).then(parts => {
            const summary = parts.filter(Boolean).join(', ');
            if (summary) this.snackBar.open(`Applied: ${summary}`, undefined, { duration: 4000 });
          });
        });
      },
      error: () => {
        this.analyzingChapter.set(false);
        this.snackBar.dismiss();
        this.snackBar.open('Chapter analysis failed', undefined, { duration: 4000 });
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
    this.pendingSuggestions.update(list => {
      const dismissed = list[index];
      if (dismissed) {
        this.dismissedEntityNames.add(dismissed.name.toLowerCase());
      }
      return list.filter((_, i) => i !== index);
    });
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

  openAiStats(): void {
    this.editingEntity.set(null);
    const current = this.chapter();
    if (current && this.editorRef) {
      this.chapter.set({ ...current, content: this.editorRef.getContent() });
    }
    this.showAiStats.set(true);
  }
  closeAiStats(): void { this.showAiStats.set(false); }

  onRightPanelChange(open: boolean): void {
    if (!open) { this.editingEntity.set(null); this.showAiStats.set(false); }
  }

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
    const versions = this.historyVersions();
    const idx = versions.findIndex(v => v.id === version.id);
    // versions are newest-first, so previous version is at idx+1
    const prev = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1] : null;
    this.previousVersion.set(prev);
    const oldText = this.stripHtml(prev ? prev.content : '');
    const newText = this.stripHtml(version.content);
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

  private computeDiff(oldText: string, newText: string): DiffParagraph[] {
    const changes = diffWords(oldText, newText);
    const paragraphs: DiffParagraph[] = [{ hasChanges: false, segments: [] }];
    for (const change of changes) {
      const type: 'same' | 'add' | 'remove' = change.added ? 'add' : change.removed ? 'remove' : 'same';
      const parts = change.value.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) paragraphs.push({ hasChanges: false, segments: [] });
        if (parts[i]) {
          const para = paragraphs[paragraphs.length - 1];
          para.segments.push({ type, text: parts[i] });
          if (type !== 'same') para.hasChanges = true;
        }
      }
    }
    return paragraphs.filter(p => p.segments.length > 0);
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

  private loadHistoryListHeight(): void {
    const stored = localStorage.getItem(ChapterEditComponent.HISTORY_LIST_HEIGHT_KEY);
    if (stored) {
      const h = parseInt(stored, 10);
      if (!isNaN(h) && h >= ChapterEditComponent.HISTORY_LIST_MIN && h <= ChapterEditComponent.HISTORY_LIST_MAX) {
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
        ChapterEditComponent.HISTORY_LIST_MIN,
        Math.min(startHeight + delta, ChapterEditComponent.HISTORY_LIST_MAX),
      )));
    };
    const upHandler = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(ChapterEditComponent.HISTORY_LIST_HEIGHT_KEY, String(this.historyListHeight()));
      this.historyResizerDrag = null;
    };
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
    this.historyResizerDrag = { startY, startHeight, moveHandler, upHandler };
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
