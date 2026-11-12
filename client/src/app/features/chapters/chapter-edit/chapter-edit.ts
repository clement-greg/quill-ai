import {
  Component, inject, signal, computed, OnInit, OnDestroy, Injector,
  ElementRef, ViewChild, HostListener, effect, untracked, viewChild, afterNextRender,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTabsModule } from '@angular/material/tabs';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSnackBar, MatSnackBarRef } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { ChapterService } from '../chapter.service';
import { ContentFilterWarning } from '@shared/models/chapter-chunk.model';
import { ChapterDraftService } from './chapter-draft.service';
import { ChapterVersionService } from './chapter-version.service';
import { Chapter, ChapterNote, noteAnchorExcerpt, OutlineItem } from '@shared/models/chapter.model';
import { ChatSessionSummary } from '@shared/models';
import { Entity } from '@shared/models/entity.model';
import { EntityQuote } from '@shared/models';
import { BookService } from '@app/features/books/book.service';
import { EntityService } from '@app/features/entities/entity.service';
import { EntityQuoteService } from '@app/features/entities/entity-quote.service';
import { TimelineEventService } from '@app/features/entities/timeline-event.service';
import { ChapterAnalysisDialogComponent, ChapterAnalysisDialogData, ChapterAnalysisDialogResult } from './chapter-analysis-dialog';
import { FactCheckPanelComponent } from './fact-check-panel';
import { FactCheckToastComponent, FactCheckToastData } from './fact-check-toast';
import { DraftDiffDialogComponent, DraftDiffDialogData } from './draft-diff-dialog';
import { EntityRelationshipService } from '@app/features/entities/entity-relationship.service';
import { SeriesService } from '@app/features/series/series.service';
import { SlideOutPanelContainer } from '@app/shared/slide-out-panel-container/slide-out-panel-container';
import { EntityEditComponent } from '@app/features/entities/entity-edit/entity-edit';
import { ImageGenDialogComponent, ImageGenDialogData, ImageGenResult } from '@app/features/entities/entity-edit/image-gen-dialog';
import { RichTextEditorComponent, SuggestedEntityCard } from '@app/shared/rich-text-editor/rich-text-editor';
import { AiStatsComponent } from '@app/features/books/book-detail/ai-stats/ai-stats';
import { ChapterOutlineComponent } from './chapter-outline/chapter-outline';
import { HeaderService } from '@app/core/services/header.service';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { AuthService } from '@app/core/auth/auth.service';
import { SeriesContextService } from '@app/core/services/series-context.service';
import { EditorBridgeService } from '../editor-bridge.service';
import { QuickChatService } from '@app/features/ai/quick-chat.service';
import { ChapterSyncService } from '../chapter-sync.service';
import { RecentChaptersService } from '../recent-chapters.service';
import { EditorReviewService } from '../editor-review.service';
import { FactCheckService } from '../fact-check.service';
import { FactCheckReportService } from '../fact-check-report.service';
import { QuillReviewPanelComponent } from './quill-review-panel/quill-review-panel';
import { MentionedEntitiesPanelComponent } from './mentioned-entities-panel';
import { VersionHistoryPanelComponent } from './version-history-panel/version-history-panel';
import { DialogueTaggingStatusComponent } from './dialogue-tagging-status';
import { ConfirmDialogComponent } from '@app/shared/confirm-dialog/confirm-dialog';
import { MoveTextDialogComponent, MoveTextDialogData, MoveTextDialogResult } from './move-text-dialog';
import { insertHtmlAtAnchor } from './chapter-content-blocks';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { DialogueHighlightsService } from '@app/shared/rich-text-editor/dialogue-highlights';
import { ReadAloudSegment } from '@app/core/read-aloud/read-aloud.model';
import { findReadAloudRange, revealRange, setReadAloudHighlight } from '@app/core/read-aloud/read-aloud-highlight';
import { TasksService } from '@app/features/tasks/tasks.service';
import {
  TaskFulfillmentDialogComponent,
  TaskFulfillmentDialogData,
  TaskFulfillmentDialogResult,
} from '@app/features/tasks/task-fulfillment-dialog';
import { BookEditorComponent, BookChapter, ChapterSplitEvent } from '../book-editor/book-editor';
import { BookTextIndex, countMatches, firstMatchFrom, locateMatch } from '../book-editor/book-search';
import { forkJoin, Subscription, map } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { readSidebarCollapsed, writeSidebarCollapsed } from './sidebar-collapse';
import { adjacentChapters, ChapterNavItem } from './chapter-nav';

@Component({
  selector: 'app-chapter-edit',
  imports: [
    FormsModule,
    MatButtonModule, MatIconModule, MatInputModule, MatFormFieldModule,
    MatProgressSpinnerModule, MatTabsModule, MatExpansionModule, MatDialogModule, MatMenuModule, MatSelectModule, MatTooltipModule,
    SlideOutPanelContainer, EntityEditComponent, RichTextEditorComponent, AiStatsComponent, ChapterOutlineComponent,
    QuillReviewPanelComponent, VersionHistoryPanelComponent, MentionedEntitiesPanelComponent, DialogueTaggingStatusComponent,
    FactCheckPanelComponent, BookEditorComponent, MatButtonToggleModule,
  ],
  templateUrl: './chapter-edit.html',
  styleUrls: ['./chapter-edit.scss', './chapter-edit-book-mode.scss'],
})
export class ChapterEditComponent implements OnInit, OnDestroy {
  @ViewChild('rte') private singleEditor?: RichTextEditorComponent;
  private bookEditor = viewChild(BookEditorComponent);
  /** The editor for the chapter in scope: the single-chapter editor or, in
   *  full-book mode, the active chapter's editor (undefined while unmounted). */
  get editorRef(): RichTextEditorComponent | undefined {
    if (this.bookMode()) return this.bookEditor()?.editorFor(this.chapter()?.id);
    return this.singleEditor;
  }
  private quillPanel = viewChild(QuillReviewPanelComponent);
  private historyPanel = viewChild(VersionHistoryPanelComponent);
  @ViewChild('noteInputEl') noteInputEl!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('editNoteEl') editNoteEl?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('searchInputEl') searchInputEl?: ElementRef<HTMLInputElement>;

  private injector = inject(Injector);
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
  private tasksService = inject(TasksService);
  private headerService = inject(HeaderService);
  private userSettings = inject(UserSettingsService);
  private authService = inject(AuthService);
  private seriesContext = inject(SeriesContextService);
  private editorBridge = inject(EditorBridgeService);
  private quickChat = inject(QuickChatService);
  private chapterSync = inject(ChapterSyncService);
  private recentChapters = inject(RecentChaptersService);
  private factCheckService = inject(FactCheckService);
  private factCheckReports = inject(FactCheckReportService);
  private readonly readAloud = inject(ReadAloudService);
  readonly dialogueHighlights = inject(DialogueHighlightsService);
  /** Public so the template can read the streamed review suggestions. */
  readonly editorReview = inject(EditorReviewService);
  private routeSub?: Subscription;
  private chapterSyncSub?: Subscription;
  private draftAcceptedSub?: Subscription;
  /** Guards async callbacks that outlive a navigation away from the editor. */
  private destroyed = false;

  // ── Full-book mode ───────────────────────────────────────────────────────
  /** Narrowest viewport that offers full-book editing (an 8.5in page plus sidebar). */
  static readonly BOOK_MIN_WIDTH = 900;
  readonly viewportWide = signal(window.innerWidth >= ChapterEditComponent.BOOK_MIN_WIDTH);
  /** Every chapter of the book on one paginated canvas (user setting + wide screen). */
  readonly bookMode = computed(() => this.userSettings.fullBookEditing() && this.viewportWide());
  /** Chapters handed to the book editor, in book order. */
  readonly bookChapters = signal<BookChapter[]>([]);
  /** Per-chapter state while the book is open. The active chapter's live state
   *  is in `chapter`/`notes`/`outline`; it is copied back on every switch. */
  private bookSlots = new Map<string, BookSlot>();
  /** Chapters with changes since their last save (only these are saved). */
  readonly dirtyChapterIds = signal<ReadonlySet<string>>(new Set());
  /** Keeps the sidebar on the current chapter while work is running against it. */
  readonly bookPinActive = computed(() =>
    this.editorReview.running() || this.quillOpenCount() > 0 || this.factChecking() ||
    this.analyzingChapter() || this.noteInputVisible(),
  );
  private urlSyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** The book's chapters in reading order, for the previous / next buttons. */
  private readonly bookChapterList = signal<ChapterNavItem[]>([]);
  readonly adjacent = computed(() => adjacentChapters(this.bookChapterList(), this.chapter()?.id));
  private headerBase: {
    series: { id: string; title: string };
    seriesItems: { label: string; link: string; isCurrent: boolean }[];
    book: { id: string; title: string };
    bookItems: { label: string; link: string; isCurrent: boolean }[];
    chapters: { id: string; title: string }[];
  } | null = null;
  private onWindowResize = (): void => {
    const wide = window.innerWidth >= ChapterEditComponent.BOOK_MIN_WIDTH;
    if (wide !== this.viewportWide()) void this.switchMode(() => this.viewportWide.set(wide));
  };

  // ── Chapter state ────────────────────────────────────────────────────────
  chapter = signal<Chapter | null>(null);
  saving = signal(false);
  hasDraft = signal(false);
  entities = signal<Entity[]>([]);
  /** PERSON entities only, for the chapter point-of-view picker. */
  personEntities = computed(() => this.entities().filter(e => e.type === 'PERSON'));
  seriesId = signal('');
  private bookTitle = signal('');
  private seriesTitle = signal('');

  // Computed AI endpoint for the editor
  aiEndpoint = computed(() => {
    const ch = this.chapter();
    return ch ? `/api/chat/${ch.id}` : '/api/chat/general';
  });

  // ── Entity quotes ────────────────────────────────────────────────────────
  capturingQuote = signal(false);

  // ── Chapter analysis (timeline + relationships) ──────────────────────────
  analyzingChapter = signal(false);

  // ── Fact check ───────────────────────────────────────────────────────────
  /** True while a fact-check run is streaming; the service owns the run state. */
  factChecking = computed(() => this.factCheckService.running());
  /** Whether the report panel is showing in the right slide-out. */
  private factCheckToast?: MatSnackBarRef<FactCheckToastComponent>;

  // ── Outline ──────────────────────────────────────────────────────────────
  outline = signal<OutlineItem[]>([]);

  // ── Notes (in-text annotation) ───────────────────────────────────────────
  notes = signal<ChapterNote[]>([]);
  noteInputVisible = signal(false);
  noteInputTop = signal(0);
  noteInputLeft = signal(0);
  noteInputText = signal('');
  highlightedNoteId = signal<string | null>(null);
  /** Id of the note currently being edited inline (click-to-edit), or null. */
  editingNoteId = signal<string | null>(null);
  editingNoteText = signal('');
  private noteSelectionRange: Range | null = null;

  // ── Linked chats ─────────────────────────────────────────────────────────
  linkedChats = signal<ChatSessionSummary[]>([]);
  linkedChatsLoading = signal(false);

  // ── Chapter image ──────────────────────────────────────────────────────
  imageUrl = signal<string | null>(null);
  imageThumbnailUrl = signal<string | null>(null);
  imageUploading = signal(false);

  // ── Mentioned entities (avatar stack over the editor) ────────────────────
  /** Editor HTML sampled for mention detection — set on load and (debounced) on edit. */
  private mentionContent = signal('');
  private mentionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Entities with at least one linked entity-reference span in the chapter,
   *  ordered by first appearance. Matches the same source of truth as
   *  `countEntityReferences`/seeking, so an entity never shows with 0 mentions. */
  mentionedEntities = computed<Entity[]>(() => {
    const html = this.mentionContent();
    const entities = this.entities();
    if (!html || entities.length === 0) return [];
    const container = document.createElement('div');
    container.innerHTML = html;
    const spans = Array.from(container.querySelectorAll<HTMLElement>('.entity-reference[data-id]'));
    const found: { entity: Entity; pos: number }[] = [];
    for (const entity of entities) {
      const pos = spans.findIndex(span => span.getAttribute('data-id') === entity.id);
      if (pos !== -1) found.push({ entity, pos });
    }
    return found.sort((a, b) => a.pos - b.pos).map(f => f.entity);
  });

  // ── Entity editing slide-out ─────────────────────────────────────────────
  editingEntity = signal<Entity | null>(null);

  // ── AI stats slide-out ───────────────────────────────────────────────────
  showAiStats = signal(false);

  // ── Entity suggestions (from editor grammar check) ───────────────────────
  pendingSuggestions = signal<SuggestedEntityCard[]>([]);
  /** True while any suggestion card has its inline editor open, so the rest of
   *  the list can be hidden and the editor given the full panel. */
  suggestionEditingActive = computed(() =>
    this.pendingSuggestions().some(c => c.creating && !!c.draftEntity),
  );
  private suggestedEntityNames = new Set<string>();
  private dismissedEntityNames = new Set<string>();

  // ── Find-in-page search ──────────────────────────────────────────────────
  searchVisible = signal(false);
  searchQuery = signal('');
  searchMatchCount = signal(0);
  searchMatchIndex = signal(0); // 0-based
  /** What the find bar searches: the chapter in scope, or (Book view) every chapter. */
  searchScope = signal<'chapter' | 'book'>('chapter');
  /** Which chapter the current book-wide match is in, for the find bar. */
  searchLocation = signal('');
  private bookSearchCounts: { id: string; count: number }[] = [];
  private bookSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private bookTextIndex = new BookTextIndex();

  // ── Sidebar ──────────────────────────────────────────────────────────────
  mobileSidebarOpen = signal(false);
  sidebarTabIndex = signal(0);
  sidebarWidth = signal(350);
  /** Desktop only: the author has tucked the sidebar away to give the editor
   *  the full width. Open by default; the choice is remembered. */
  sidebarCollapsed = signal(false);

  // ── Quill Editor (AI review pass) ─────────────────────────────────────────
  /** Index of the "Quill Editor" sidebar tab. */
  static readonly QUILL_REVIEW_TAB = 3;
  /** Index of the "Fact Check" sidebar tab. */
  static readonly FACT_CHECK_TAB = 4;
  /** Open-suggestion count for the sidebar/mobile tab badges; the panel itself
   *  lives in QuillReviewPanelComponent. */
  quillOpenCount = computed(() =>
    this.editorReview.visible(false).filter(s => s.status === 'open').length,
  );

  /** Findings still asking something of the author in the saved report on show,
   *  for the tab badge — so an unfinished fact check stays visible with the tab
   *  closed. Verified claims are excluded; they need no action. */
  factCheckOpenCount = computed(() => this.factCheckReports.openActionableCount());
  /** Suggestion id currently hovered in the document (doc→sidebar highlight). */
  quillHoveredId = signal<string | null>(null);

  // Track emails whose avatar endpoint returned an error so we fall back to the placeholder icon
  private _avatarErrors = signal<ReadonlySet<string>>(new Set());
  avatarFailed(email: string): boolean { return this._avatarErrors().has(email); }
  onAvatarError(email: string): void { this._avatarErrors.update(s => new Set([...s, email])); }

  private onDocumentKeyDown = (e: KeyboardEvent): void => {
    const isF = e.code === 'KeyF' || e.key.toLowerCase() === 'f';
    if ((e.ctrlKey || e.metaKey) && !e.altKey && isF && this.chapter()) {
      e.preventDefault();
      if (!e.shiftKey) {
        this.openSearch('chapter');
      } else if (this.bookMode()) {
        this.openSearch('book');
      } else {
        // The whole book is only loaded in Book view.
        const ref = this.snackBar.open('Searching the whole book works in Book view', 'Switch to Book view', { duration: 6000 });
        ref.onAction().subscribe(() => this.setBookMode(true));
      }
    } else if (e.key === 'Escape' && this.searchVisible()) {
      this.closeSearch();
    }
  };

  private resizerDrag: {
    startX: number; startWidth: number;
    moveHandler: (e: MouseEvent) => void; upHandler: () => void;
  } | null = null;

  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicSaveTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly PERIODIC_SAVE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  /** Content as of the last successful server save — used to skip auto-saves when nothing changed. */
  private lastSavedContent: string | null = null;

  // ── Task fulfillment ─────────────────────────────────────────────────────
  /** Content the last task check covered (initially as loaded): the next check looks at changes since. */
  private taskCheckBaseline: string | null = null;
  /** Tasks the author said "not yet" to while this chapter is open, so they aren't asked again. */
  private declinedTaskIds = new Set<string>();
  private taskCheckInFlight = false;

  // ── Extra ctx menu items passed to the editor ────────────────────────────
  readonly ctxMenuExtraItems: { id: string; label: string; icon: string }[] = [
    { id: 'capture-quote', label: 'Capture quote', icon: 'record_voice_over' },
    { id: 'capture-narrator-quote', label: 'Capture Narrator Quote', icon: 'menu_book' },
  ];

  constructor() {
    // Reload linked chats whenever the active session's chapter pin changes
    effect(() => {
      this.quickChat.pinnedChapterId(); // track both pin and unpin
      const chapterId = this.chapter()?.id;
      if (chapterId) {
        untracked(() => void this.loadLinkedChats(chapterId));
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

    // Keep the editor bridge current when outline or notes change so the
    // quick-chat panel always has the latest chapter context.
    effect(() => {
      const outline = this.outline();
      const notes = this.notes();
      untracked(() => this.editorBridge.updateChapterOutlineAndNotes(outline, notes));
    });

    // Follow the read-aloud player: highlight the paragraph being read and
    // move to the next chapter when playback reaches it.
    effect(() => {
      const segment = this.readAloud.current();
      const chapterId = this.chapter()?.id;
      untracked(() => void this.followReadAloud(segment, chapterId));
    });
  }

  ngOnInit(): void {
    document.addEventListener('keydown', this.onDocumentKeyDown);
    this.loadSidebarWidth();
    this.loadSidebarCollapsed();
    this.initSubscriptions();

    window.addEventListener('resize', this.onWindowResize);
    this.routeSub = this.route.paramMap.subscribe(params => {
      const id = params.get('id')!;
      // Within the open book, a chapter link just moves to that chapter.
      if (this.bookMode() && this.bookSlots.has(id)) {
        this.goToBookChapter(id);
        return;
      }
      this.resetBook();
      this.loadChapter(id);
    });

  }

  /** Loads a chapter (and, in full-book mode, the rest of its book). */
  private loadChapter(id: string): void {
      this.chapter.set(null);
      this.hasDraft.set(false);
      this.notes.set([]);
      this.outline.set([]);
      this.lastSavedContent = null;
      this.taskCheckBaseline = null;
      this.declinedTaskIds.clear();
      this.mentionContent.set('');

      this.chapterService.getById(id).subscribe({
      next: async (data) => {
        const draft = await this.draftService.resolvePendingDraft(data);
        const hasDraft = draft !== null;
        const content = hasDraft ? draft.content : (data.content ?? '');
        const notes = hasDraft ? draft.notes : (data.notes ?? []);
        const outline = hasDraft ? draft.outline : (data.outline ?? []);
        if (hasDraft) this.hasDraft.set(true);
        this.chapter.set({ ...data, content });
        this.notes.set(notes);
        this.outline.set(outline);
        void this.loadLinkedChats(data.id);
        this.imageUrl.set(data.imageUrl ?? null);
        this.imageThumbnailUrl.set(data.imageThumbnailUrl ?? null);
        this.lastSavedContent = data.content ?? '';
        this.taskCheckBaseline = data.content ?? '';
        this.mentionContent.set(content);
        if (this.bookMode()) this.loadBook({ ...data, content }, notes, outline, hasDraft);

        // Set editor content after view init (setTimeout ensures ViewChild is ready)
        setTimeout(() => {
          if (this.editorRef && !this.bookMode()) {
            this.editorRef.setContent(content);
            this.editorBridge.register(this.editorRef);
            this.editorBridge.setChapterContext({ chapterId: data.id, seriesId: this.seriesId() || null });
            this.pinAnchoredNotes();
            // If the Ask Quill "edit chapter" tool navigated us here, kick off the
            // editorial pass now that the editor has content. A nested timeout
            // lets the freshly-set content settle before we extract blocks.
            if (this.editorReview.consumeAutoRun(data.id)) {
              setTimeout(() => this.startQuillReview());
            }
          }
        });

        this.bookService.getById(data.bookId).subscribe({
          next: (book) => {
            this.seriesId.set(book.seriesId);
            this.seriesContext.set(book.seriesId);
            this.editorBridge.setChapterContext({ chapterId: data.id, seriesId: book.seriesId });

            forkJoin({
              series: this.seriesService.getById(book.seriesId),
              allSeries: this.seriesService.getAll(),
              booksInSeries: this.bookService.getBySeries(book.seriesId),
              chaptersInBook: this.chapterService.getByBook(data.bookId),
            }).subscribe({
              next: ({ series, allSeries, booksInSeries, chaptersInBook }) => {
                this.bookTitle.set(book.title);
                this.seriesTitle.set(series.title);
                this.recordRecentChapter();
                const filteredSeries = allSeries.filter(s => !s.archived && !s.deleted);
                const filteredBooks = booksInSeries.filter(b => !b.archived && !b.deleted)
                  .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
                const sortedChapters = [...chaptersInBook]
                  .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
                this.headerBase = {
                  series,
                  seriesItems: filteredSeries.map(s => ({ label: s.title, link: '/series/' + s.id, isCurrent: s.id === series.id })),
                  book,
                  bookItems: filteredBooks.map(b => ({ label: b.title, link: '/books/' + b.id, isCurrent: b.id === book.id })),
                  chapters: sortedChapters.map(c => ({ id: c.id, title: c.title })),
                };
                this.bookChapterList.set(sortedChapters
                  .filter(c => !c.archived)
                  .map(c => ({ id: c.id, title: c.title })));
                this.updateHeader();
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

  private initSubscriptions(): void {
    this.chapterSyncSub = this.chapterSync.updates$.subscribe(async update => {
      const current = this.chapter();
      if (!current || current.id !== update.id) return;
      if (update.outline !== undefined) this.outline.set(update.outline);
      if (update.notes !== undefined) {
        this.notes.set(update.notes);
        this.pinAnchoredNotes();
      }
      // Persist the externally-applied change into the draft so a subsequent
      // page refresh also shows the new data instead of the stale draft.
      const content = this.editorRef?.getContent() ?? current.content ?? '';
      await this.draftService.saveDraft(current.id, content, this.notes(), this.outline());
    });

    // When an AI chapter draft is accepted from the Ask Quill panel, analyze the
    // new content so timeline/relationship canon stays in sync (closes the loop).
    // setTimeout lets the editor's content settle before we read it.
    this.draftAcceptedSub = this.editorBridge.draftAccepted$.subscribe(() => {
      setTimeout(() => this.analyzeChapter());
    });
  }

  // ── Full-book mode ───────────────────────────────────────────────────────

  // ── Read aloud ───────────────────────────────────────────────────────────

  /** Chapter the player was last following here, to tell "playback moved on"
   *  from "the author browsed to another chapter". */
  private readAloudFollowing: string | null = null;
  private readAloudSeq = 0;

  private async followReadAloud(segment: ReadAloudSegment | null, chapterId: string | undefined): Promise<void> {
    const seq = ++this.readAloudSeq;
    if (!segment || !chapterId) {
      setReadAloudHighlight(null);
      if (!segment) this.readAloudFollowing = null;
      return;
    }
    if (segment.chapterId !== chapterId) {
      setReadAloudHighlight(null);
      // Only follow if the author was on the chapter that just finished;
      // if they browsed elsewhere, leave them there.
      if (this.readAloudFollowing !== chapterId) return;
      this.readAloudFollowing = segment.chapterId;
      if (this.bookMode()) {
        if (!this.bookChapters().some(c => c.id === segment.chapterId)) return;
        this.bookEditor()?.scrollToChapter(segment.chapterId);
        this.activateBookChapter(segment.chapterId);
      } else {
        await this.persistSingleDraft();
        if (this.destroyed) return;
        void this.router.navigate(['/chapters', segment.chapterId, 'edit']);
      }
      return;
    }
    this.readAloudFollowing = chapterId;
    // The editor may still be loading this chapter; wait for the paragraph to appear.
    for (let frame = 0; frame < 90; frame++) {
      if (seq !== this.readAloudSeq || this.destroyed) return;
      const el = this.editorRef?.getEditorElement();
      if (el?.isConnected) {
        const range = findReadAloudRange(el, segment.blockIndex, segment.text);
        if (range || segment.blockIndex < 0) {
          setReadAloudHighlight(range);
          if (range) revealRange(range);
          return;
        }
      }
      await new Promise(r => requestAnimationFrame(r));
    }
    setReadAloudHighlight(null);
  }

  /** Moves to the previous or next chapter of the book, keeping any unsaved
   *  work in this one as a draft. */
  async goToAdjacentChapter(direction: 'prev' | 'next'): Promise<void> {
    const target = this.adjacent()[direction];
    if (!target || this.bookMode()) return;
    await this.persistSingleDraft();
    if (this.destroyed) return;
    void this.router.navigate(['/chapters', target.id, 'edit']);
  }

  /** Switches between single-chapter and full-book editing. */
  setBookMode(on: boolean): void {
    if (on === this.userSettings.fullBookEditing()) return;
    void this.switchMode(() => this.userSettings.setFullBookEditing(on));
  }

  /** Runs a change that may flip the editing mode, carrying unsaved work across:
   *  the outgoing editor's changes are written to drafts, and the chapter is
   *  reloaded in the new mode (which picks the drafts back up). */
  private async switchMode(apply: () => void): Promise<void> {
    const wasBook = this.bookMode();
    const id = this.chapter()?.id;
    if (wasBook) await this.persistBookDrafts();
    else await this.persistSingleDraft();
    apply();
    if (this.bookMode() === wasBook || !id || this.destroyed) return;
    this.resetBook();
    this.loadChapter(id);
  }

  private async persistSingleDraft(): Promise<void> {
    const ch = this.chapter();
    const editor = this.singleEditor;
    if (!ch || !editor) return;
    if (this.autoSaveTimer) { clearTimeout(this.autoSaveTimer); this.autoSaveTimer = null; }
    const content = editor.getContent();
    if (content !== this.lastSavedContent || this.hasDraft()) {
      await this.draftService.saveDraft(ch.id, content, this.notes(), this.outline());
    }
  }

  private async persistBookDrafts(): Promise<void> {
    this.bookEditor()?.flushAll();
    this.stashActive();
    if (this.autoSaveTimer) { clearTimeout(this.autoSaveTimer); this.autoSaveTimer = null; }
    const dirty = this.dirtyChapterIds();
    await Promise.all([...this.bookSlots.values()]
      .filter(slot => dirty.has(slot.chapter.id))
      .map(slot => this.draftService.saveDraft(slot.chapter.id, slot.content, slot.notes, slot.outline)));
  }

  private resetBook(): void {
    this.bookSlots.clear();
    this.bookChapters.set([]);
    this.dirtyChapterIds.set(new Set());
    if (this.urlSyncTimer) { clearTimeout(this.urlSyncTimer); this.urlSyncTimer = null; }
  }

  /** Loads every chapter of the active chapter's book into the book editor,
   *  each with its pending local draft if it has one. */
  private loadBook(active: Chapter, activeNotes: ChapterNote[], activeOutline: OutlineItem[], activeHasDraft: boolean): void {
    this.chapterService.getByBook(active.bookId).subscribe({
      next: async list => {
        const stillHere = () => !this.destroyed && this.bookMode() && this.chapter()?.id === active.id;
        if (!stillHere()) return;
        const sorted = list
          .filter(c => !c.archived)
          .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
        if (!sorted.some(c => c.id === active.id)) sorted.push(active);
        const slots = await Promise.all(sorted.map(async c => {
          if (c.id === active.id) {
            return makeSlot(active, active.content ?? '', activeNotes, activeOutline, activeHasDraft, this.lastSavedContent ?? '');
          }
          const draft = await this.draftService.resolvePendingDraft(c);
          return makeSlot(c, draft?.content ?? c.content ?? '', draft?.notes ?? c.notes ?? [], draft?.outline ?? c.outline ?? [], !!draft, c.content ?? '');
        }));
        if (!stillHere()) return;
        // The active chapter may have been edited while the rest loaded.
        const activeSlot = slots.find(sl => sl.chapter.id === active.id)!;
        activeSlot.chapter = { ...this.chapter()! };
        activeSlot.content = this.chapter()!.content ?? activeSlot.content;
        this.bookSlots = new Map(slots.map(sl => [sl.chapter.id, sl]));
        this.dirtyChapterIds.set(new Set(slots.filter(sl => sl.hasDraft).map(sl => sl.chapter.id)));
        this.bookChapters.set(slots.map(sl => ({ id: sl.chapter.id, title: sl.chapter.title, content: sl.content })));
        this.updateHeader();
        afterNextRender({ write: () => this.bookEditor()?.scrollToChapter(active.id) }, { injector: this.injector });
      },
      error: () => this.snackBar.open("Couldn't load the rest of the book", undefined, { duration: 4000 }),
    });
  }

  /** Copies the active chapter's live state back into its slot. */
  private stashActive(): void {
    const ch = this.chapter();
    const slot = ch && this.bookSlots.get(ch.id);
    if (!ch || !slot) return;
    const editor = this.editorRef;
    slot.content = editor ? editor.getContent() : (ch.content ?? slot.content);
    slot.chapter = { ...ch, content: slot.content };
    slot.notes = this.notes();
    slot.outline = this.outline();
    slot.hasDraft = this.hasDraft();
    slot.taskCheckBaseline = this.taskCheckBaseline;
    if (this.dirtyChapterIds().has(ch.id)) this.writeSlotDraft(slot);
  }

  /** Scrolls the book to a chapter and makes it the one in scope. */
  private goToBookChapter(id: string): void {
    if (this.chapter()?.id === id) return;
    this.activateBookChapter(id);
    // Put the caret at the chapter's start so typing lands where the reader is.
    this.bookEditor()?.focusChapter(id, 'body');
  }

  /** Makes `id` the chapter the sidebar, toolbar and tools work on. */
  activateBookChapter(id: string, force = false): void {
    const current = this.chapter();
    if (current?.id === id && !force) return;
    const slot = this.bookSlots.get(id);
    if (!slot) return;
    // A forced re-entry means the slot was just rewritten; don't clobber it.
    if (!force) this.stashActive();
    // stashActive() wrote the outgoing chapter's draft; its pending timer would
    // otherwise fire against the chapter we're switching to.
    if (this.autoSaveTimer) { clearTimeout(this.autoSaveTimer); this.autoSaveTimer = null; }
    // A chapter-scoped find doesn't carry over; a book-wide one drives the switch.
    if (this.searchVisible() && !this.isBookSearch) this.closeSearch();
    this.dismissNoteInput();
    this.cancelEditNote();

    this.chapter.set({ ...slot.chapter, content: slot.content });
    this.notes.set(slot.notes);
    this.outline.set(slot.outline);
    this.hasDraft.set(slot.hasDraft);
    this.lastSavedContent = slot.savedContent;
    this.taskCheckBaseline = slot.taskCheckBaseline;
    this.declinedTaskIds.clear();
    this.imageUrl.set(slot.chapter.imageUrl ?? null);
    this.imageThumbnailUrl.set(slot.chapter.imageThumbnailUrl ?? null);
    this.mentionContent.set(slot.content);
    this.pendingSuggestions.set([]);
    this.registerActiveEditor();
    this.pinAnchoredNotes();
    this.updateHeader();
    this.recordRecentChapter();
    this.scheduleUrlSync(id);
  }

  /** Points Ask Quill (insert at cursor, chapter grounding) at the active editor. */
  private registerActiveEditor(): void {
    const ch = this.chapter();
    const editor = this.editorRef;
    if (!ch || !editor) return;
    this.editorBridge.register(editor);
    this.editorBridge.setChapterContext({ chapterId: ch.id, seriesId: this.seriesId() || null });
  }

  /** Keeps the address bar on the chapter in scope, so refresh and sharing land
   *  in the same place. Debounced so scrolling doesn't spam history. */
  private scheduleUrlSync(id: string): void {
    if (this.urlSyncTimer) clearTimeout(this.urlSyncTimer);
    this.urlSyncTimer = setTimeout(() => {
      this.urlSyncTimer = null;
      if (this.chapter()?.id !== id || this.destroyed) return;
      void this.router.navigate(['/chapters', id, 'edit'], { replaceUrl: true });
    }, 600);
  }

  onBookEditorMounted(id: string): void {
    if (id !== this.chapter()?.id) return;
    this.registerActiveEditor();
    this.pinAnchoredNotes();
    if (this.editorReview.consumeAutoRun(id)) setTimeout(() => this.startQuillReview());
  }

  private markDirty(id: string | undefined): void {
    if (!id || !this.bookMode() || this.dirtyChapterIds().has(id)) return;
    this.dirtyChapterIds.update(set => new Set(set).add(id));
  }

  onBookChapterInput(id: string): void {
    this.markDirty(id);
  }

  onBookChapterContent(event: { id: string; html: string }): void {
    const slot = this.bookSlots.get(event.id);
    if (!slot) return;
    const isActive = event.id === this.chapter()?.id;
    const previous = isActive ? (this.chapter()?.content ?? slot.content) : slot.content;
    slot.content = event.html;
    if (event.html !== previous) {
      this.bookChapters.update(list => list.map(c => (c.id === event.id ? { ...c, content: event.html } : c)));
    }
    if (isActive) {
      if (event.html !== previous) {
        this.chapter.update(ch => (ch ? { ...ch, content: event.html } : ch));
        this.onEditorContentChange(event.html);
      }
    } else {
      this.writeSlotDraft(slot);
    }
  }

  /** Writes a non-active chapter's local draft if its content moved on since
   *  the last draft write (drafts are what survive a reload or a mode switch). */
  private writeSlotDraft(slot: BookSlot): void {
    if (slot.content === slot.draftContent) return;
    if (slot.content === slot.savedContent && !this.dirtyChapterIds().has(slot.chapter.id)) return;
    slot.draftContent = slot.content;
    slot.hasDraft = true;
    void this.draftService.saveDraft(slot.chapter.id, slot.content, slot.notes, slot.outline);
  }

  onBookTitleChange(event: { id: string; title: string }): void {
    if (event.id === this.chapter()?.id) {
      this.updateTitle(event.title);
      return;
    }
    const slot = this.bookSlots.get(event.id);
    if (!slot) return;
    slot.chapter = { ...slot.chapter, title: event.title };
    this.bookChapters.update(list => list.map(c => (c.id === event.id ? { ...c, title: event.title } : c)));
    this.markDirty(event.id);
  }

  /** "# Title" / Ctrl+Enter: creates the new chapter right after the source.
   *  The chapter itself is created now (it needs an id for notes, chats and
   *  drafts); the prose moved into it stays a draft until Save, like any edit. */
  onSplitChapter(event: ChapterSplitEvent): void {
    const source = this.bookSlots.get(event.sourceId);
    if (!source) return;
    if (event.html) this.markDirty(event.sourceId);
    const index = this.bookChapters().findIndex(c => c.id === event.sourceId);
    const draft: Chapter = {
      id: uuidv4(),
      title: event.title,
      bookId: source.chapter.bookId,
      content: '',
      sortOrder: index + 1,
    };
    this.chapterService.create(draft).subscribe({
      next: created => {
        if (this.destroyed || !this.bookMode()) return;
        const order = [...this.bookChapters().map(c => c.id)];
        order.splice(order.indexOf(event.sourceId) + 1, 0, created.id);
        this.chapterService.reorder(order.map((id, i) => ({ id, sortOrder: i }))).subscribe();
        order.forEach((id, i) => {
          const sl = this.bookSlots.get(id);
          if (sl) sl.chapter = { ...sl.chapter, sortOrder: i };
        });
        const slot = makeSlot({ ...created, sortOrder: order.indexOf(created.id) }, event.html, [], [], !!event.html, '');
        this.bookSlots.set(created.id, slot);
        if (event.html) void this.draftService.saveDraft(created.id, event.html, [], []);
        this.dirtyChapterIds.update(set => new Set(set).add(created.id));
        this.bookChapters.update(list => {
          const next = [...list];
          next.splice(next.findIndex(c => c.id === event.sourceId) + 1, 0,
            { id: created.id, title: created.title, content: event.html });
          return next;
        });
        afterNextRender({ write: () => this.bookEditor()?.focusChapter(created.id, event.focus) }, { injector: this.injector });
        this.snackBar.open(`Started "${created.title}"`, undefined, { duration: 2500 });
      },
      error: () => {
        // Put the moved text back where it came from.
        const el = this.bookEditor()?.editorFor(event.sourceId)?.getEditorElement();
        if (el && event.html) {
          el.insertAdjacentHTML('beforeend', event.html);
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        this.snackBar.open("Couldn't create the new chapter — the text was put back", undefined, { duration: 5000 });
      },
    });
  }

  /** "New chapter" button under the last page: an empty chapter at the end. */
  onNewChapterAtEnd(): void {
    const last = this.bookChapters().at(-1);
    if (last) this.onSplitChapter({ sourceId: last.id, title: 'New Chapter', html: '', focus: 'title' });
  }

  /** Backspace at the very start of a chapter: offer to merge it into the one before. */
  onMergeRequest(id: string): void {
    const list = this.bookChapters();
    const index = list.findIndex(c => c.id === id);
    if (index <= 0) return;
    const prev = list[index - 1]!;
    const cur = list[index]!;
    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: 'Merge into the previous chapter?',
        message: `"${cur.title || 'Untitled chapter'}" will be added to the end of "${prev.title || 'Untitled chapter'}", and the now-empty chapter will be archived (you can restore it from the archive).`,
        confirm: 'Merge',
      },
      width: '420px',
    });
    ref.afterClosed().subscribe(confirmed => {
      if (!confirmed) return;
      this.bookEditor()?.flushAll();
      this.stashActive();
      const curSlot = this.bookSlots.get(id);
      const prevSlot = this.bookSlots.get(prev.id);
      if (!curSlot || !prevSlot) return;
      this.chapterService.archive(id).subscribe({
        next: () => {
          const merged = prevSlot.content + curSlot.content;
          prevSlot.content = merged;
          prevSlot.notes = [...prevSlot.notes, ...curSlot.notes];
          prevSlot.hasDraft = true;
          this.bookSlots.delete(id);
          void this.draftService.clearDraft(id);
          void this.draftService.saveDraft(prev.id, merged, prevSlot.notes, prevSlot.outline);
          this.dirtyChapterIds.update(set => {
            const next = new Set(set);
            next.delete(id);
            next.add(prev.id);
            return next;
          });
          this.bookChapters.update(chs => chs
            .filter(c => c.id !== id)
            .map(c => (c.id === prev.id ? { ...c, content: merged } : c)));
          this.bookEditor()?.setChapterContent(prev.id, merged);
          // Re-enter the previous chapter fresh so the sidebar shows the merged notes.
          this.activateBookChapter(prev.id, true);
          this.snackBar.open('Chapters merged — save to keep the change', undefined, { duration: 4000 });
        },
        error: () => this.snackBar.open("Couldn't merge the chapters", undefined, { duration: 4000 }),
      });
    });
  }

  /** After a per-chapter tool finishes in full-book mode, offers to run it on
   *  the next chapter (moving the reader there first). */
  private offerNextChapter(tool: 'analyze' | 'factCheck', prefix?: string): void {
    if (!this.bookMode() || this.destroyed) return;
    const list = this.bookChapters();
    const index = list.findIndex(c => c.id === this.chapter()?.id);
    const next = index >= 0 ? list[index + 1] : undefined;
    if (!next) {
      if (prefix) this.snackBar.open(prefix, undefined, { duration: 4000 });
      return;
    }
    const verb = tool === 'analyze' ? 'Analyze' : 'Fact check';
    const message = `${prefix ? prefix + ' — ' : ''}${verb} the next chapter, "${next.title || 'Untitled chapter'}"?`;
    const ref = this.snackBar.open(message, 'Continue', { duration: 12000 });
    ref.onAction().subscribe(() => {
      this.goToBookChapter(next.id);
      // Let the next chapter's editor mount before reading its text.
      setTimeout(() => (tool === 'analyze' ? this.analyzeChapter() : this.factCheckChapter()), 300);
    });
  }

  /** Saves every chapter changed since its last save (full-book mode). */
  private async saveBook(): Promise<void> {
    const editor = this.editorRef;
    if (editor) {
      editor.unwrapEntityQuotes();
      editor.clearEntitySeekHighlight();
    }
    if (this.autoSaveTimer) { clearTimeout(this.autoSaveTimer); this.autoSaveTimer = null; }
    this.bookEditor()?.flushAll();
    this.stashActive();
    const dirty = [...this.dirtyChapterIds()]
      .map(id => this.bookSlots.get(id))
      .filter((sl): sl is BookSlot => !!sl);
    if (dirty.length === 0) {
      this.snackBar.open('No changes to save', undefined, { duration: 2500 });
      return;
    }
    if (dirty.some(sl => !sl.chapter.title.trim())) {
      this.snackBar.open('Every chapter needs a title before saving', undefined, { duration: 4000 });
      return;
    }
    this.saving.set(true);
    const author = this.userSettings.displayName() || this.authService.currentUser()?.name || undefined;
    const results = await Promise.all(dirty.map(slot => new Promise<{ slot: BookSlot; warnings: ContentFilterWarning[] | undefined } | null>(resolve => {
      const content = slot.content;
      const outline = slot.outline.filter(item => item.text.trim() !== '');
      this.chapterService.update({ ...slot.chapter, content, notes: slot.notes, outline }).subscribe({
        next: async saved => {
          this.chapterVersionService.create(slot.chapter.id, content, author).subscribe();
          await this.draftService.clearDraft(slot.chapter.id);
          slot.savedContent = content;
          slot.draftContent = content;
          slot.hasDraft = false;
          slot.chapter = { ...slot.chapter, modifiedAt: saved.modifiedAt ?? slot.chapter.modifiedAt };
          resolve({ slot, warnings: saved.contentWarnings });
        },
        error: () => resolve(null),
      });
    })));
    if (this.destroyed) return;
    this.saving.set(false);
    const ok = results.filter((r): r is NonNullable<typeof r> => !!r);
    const savedIds = new Set(ok.map(r => r.slot.chapter.id));
    this.dirtyChapterIds.update(set => new Set([...set].filter(id => !savedIds.has(id))));
    const active = this.chapter();
    if (active && savedIds.has(active.id)) {
      const slot = this.bookSlots.get(active.id)!;
      this.lastSavedContent = slot.savedContent;
      this.hasDraft.set(false);
      this.historyPanel()?.refreshAfterSave();
      this.recordRecentChapter();
      this.checkTaskFulfillment(active.id, slot.savedContent);
    }
    const failed = results.length - ok.length;
    const warnings = ok.flatMap(r => r.warnings ?? []);
    if (failed) {
      this.snackBar.open(`Saved ${ok.length} of ${results.length} chapters — ${failed} failed, click Save to retry`, undefined, { duration: 6000 });
    } else if (warnings.length) {
      this.notifyContentWarnings(warnings);
    } else {
      this.snackBar.open(ok.length === 1 ? 'Chapter saved' : `${ok.length} chapters saved`, undefined, { duration: 3000 });
    }
  }

  private updateHeader(): void {
    const h = this.headerBase;
    const ch = this.chapter();
    if (!h || !ch) return;
    const chapters = this.bookMode() && this.bookChapters().length
      ? this.bookChapters().map(c => ({ id: c.id, title: c.title }))
      : h.chapters;
    this.headerService.set([
      { label: h.series.title, link: '/series/' + h.series.id, dropdownItems: h.seriesItems },
      { label: h.book.title, link: '/books/' + h.book.id, dropdownItems: h.bookItems },
      {
        label: ch.title || 'Chapter',
        dropdownItems: chapters.map(c => ({ label: c.title || 'Chapter', link: '/chapters/' + c.id + '/edit', isCurrent: c.id === ch.id })),
      },
    ]);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    setReadAloudHighlight(null);
    // A run has nowhere to report to once the editor is gone, so abandon it.
    this.factCheckToast?.dismiss();
    this.factCheckService.reset();
    this.factCheckReports.reset();
    document.removeEventListener('keydown', this.onDocumentKeyDown);
    window.removeEventListener('resize', this.onWindowResize);
    if (this.bookSearchTimer) clearTimeout(this.bookSearchTimer);
    if (this.urlSyncTimer) clearTimeout(this.urlSyncTimer);
    this.editorBridge.unregister();
    this.routeSub?.unsubscribe();
    this.chapterSyncSub?.unsubscribe();
    this.draftAcceptedSub?.unsubscribe();
    this.editorReview.clear();
    this.headerService.clear();
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    if (this.mentionRefreshTimer) clearTimeout(this.mentionRefreshTimer);
    this.stopPeriodicSave();
    if (this.resizerDrag) {
      document.removeEventListener('mousemove', this.resizerDrag.moveHandler);
      document.removeEventListener('mouseup', this.resizerDrag.upHandler);
    }
  }

  // ── Editor event handlers ────────────────────────────────────────────────

  private startPeriodicSave(): void {
    if (this.periodicSaveTimer) return;
    this.periodicSaveTimer = setInterval(() => {
      if (this.bookMode()) {
        if (!this.saving() && this.dirtyChapterIds().size > 0) void this.saveBook();
        return;
      }
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

  /** Opens the Ask Quill overlay; it grounds answers in this chapter (via the
   *  editor bridge) and offers an "Insert at cursor" action on its replies. */
  openAskQuill(): void {
    this.quickChat.open();
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
    this.scheduleMentionRefresh(html);
  }

  private scheduleMentionRefresh(html: string): void {
    if (this.mentionRefreshTimer) clearTimeout(this.mentionRefreshTimer);
    this.mentionRefreshTimer = setTimeout(() => {
      this.mentionContent.set(html);
      this.mentionRefreshTimer = null;
    }, 500);
  }

  onOutlineChange(items: OutlineItem[]): void {
    this.outline.set(items);
    this.markDirty(this.chapter()?.id);
    this.scheduleDraftSave();
  }

  onEntityEditRequest(entity: Entity): void {
    // One panel at a time in the right slide-out.
    this.showAiStats.set(false);
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
      this.onSidebarTabChange(1);
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

  // ── Move text to another chapter ─────────────────────────────────────────

  onMoveTextRequest(event: { text: string }): void {
    const chapter = this.chapter();
    if (!chapter) return;
    const dialogRef = this.dialog.open(MoveTextDialogComponent, {
      data: {
        bookId: chapter.bookId,
        currentChapterId: chapter.id,
        selectionPreview: event.text,
      } satisfies MoveTextDialogData,
      width: '540px',
      maxHeight: '80vh',
    });
    dialogRef.afterClosed().subscribe((result: MoveTextDialogResult | undefined) => {
      if (result) this.moveSelectedText(result);
    });
  }

  private moveSelectedText(target: MoveTextDialogResult): void {
    const chapter = this.chapter();
    if (!chapter || !this.editorRef) return;
    const previousContent = this.editorRef.getContent();
    const blocks = this.editorRef.extractMoveSelection();
    if (!blocks) {
      this.snackBar.open("Couldn't move the text — the selection was lost. Please select it again.", undefined, { duration: 4000 });
      return;
    }
    const movedHtml = blocks.join('');

    if (target.mode === 'new') {
      const newChapter: Chapter = {
        id: uuidv4(),
        title: target.title,
        bookId: chapter.bookId,
        content: movedHtml,
        sortOrder: target.sortOrder,
      };
      this.chapterService.create(newChapter).subscribe({
        next: created => this.finishMove(created.id, created.title),
        error: () => this.revertMove(previousContent),
      });
    } else {
      const content = insertHtmlAtAnchor(target.chapter.content ?? '', movedHtml, target.anchor, target.position);
      this.chapterService.update({ ...target.chapter, content }).subscribe({
        next: updated => this.finishMove(updated.id, updated.title),
        error: () => this.revertMove(previousContent),
      });
    }
  }

  /** Target save failed: put the extracted text back so nothing is lost. */
  private revertMove(previousContent: string): void {
    this.editorRef?.setContent(previousContent);
    this.scheduleDraftSave();
    this.snackBar.open('Moving the text failed — nothing was changed.', undefined, { duration: 5000 });
  }

  private finishMove(targetId: string, targetTitle: string): void {
    this.persistSourceAfterMove();
    if (this.bookMode()) this.refreshBookChapter(targetId);
    const ref = this.snackBar.open(`Text moved to "${targetTitle || 'Chapter'}"`, 'Open chapter', { duration: 8000 });
    ref.onAction().subscribe(() => window.open(`/chapters/${targetId}/edit`, '_blank'));
  }

  /** Pulls a chapter changed outside the book editor (e.g. text moved into it)
   *  back into the open book, inserting it in order if it's new. */
  private refreshBookChapter(id: string): void {
    this.chapterService.getById(id).subscribe(data => {
      if (!this.bookMode() || this.destroyed || data.bookId !== this.chapter()?.bookId) return;
      const content = data.content ?? '';
      const existing = this.bookSlots.get(id);
      if (existing) {
        const pending = this.dirtyChapterIds().has(id);
        existing.chapter = { ...data, content };
        existing.savedContent = content;
        if (!pending) existing.content = content;
        this.bookChapters.update(list => list.map(c => (c.id === id ? { ...c, content: existing.content } : c)));
        if (!pending) this.bookEditor()?.setChapterContent(id, content);
        return;
      }
      this.bookSlots.set(id, makeSlot(data, content, data.notes ?? [], data.outline ?? [], false, content));
      const ordered = [...this.bookSlots.values()]
        .sort((a, b) => (a.chapter.sortOrder ?? Infinity) - (b.chapter.sortOrder ?? Infinity));
      this.bookChapters.set(ordered.map(sl => ({ id: sl.chapter.id, title: sl.chapter.title, content: sl.content })));
    });
  }

  /** Persists the source chapter after a move — mirrors save() but without the
   *  "Chapter saved" toast, which would stomp the "Text moved" one. */
  private persistSourceAfterMove(): void {
    const chapter = this.chapter();
    if (!chapter) return;
    const content = this.editorRef?.getContent() ?? chapter.content ?? '';
    const toSave = { ...chapter, content, notes: this.notes(), outline: this.outline() };
    this.chapterService.update(toSave).subscribe({
      next: async () => {
        this.chapterVersionService.create(
          chapter.id, content,
          this.userSettings.displayName() || this.authService.currentUser()?.name || undefined,
        ).subscribe();
        await this.draftService.clearDraft(chapter.id);
        this.hasDraft.set(false);
        this.lastSavedContent = content;
        const slot = this.bookSlots.get(chapter.id);
        if (slot) {
          slot.savedContent = content;
          slot.hasDraft = false;
          this.dirtyChapterIds.update(set => new Set([...set].filter(x => x !== chapter.id)));
        }
      },
      error: () => this.snackBar.open('Text moved, but saving this chapter failed — click Save to retry', undefined, { duration: 5000 }),
    });
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
      next: ({ url, thumbnailUrl }) => this.applyChapterImage(url, thumbnailUrl),
      error: () => {
        this.snackBar.open('Image upload failed', undefined, { duration: 3000 });
        this.imageUploading.set(false);
      },
    });
  }

  /** Opens the prompt dialog, then generates and saves the chapter image. */
  openGenerateImageDialog(): void {
    const chapterId = this.chapter()?.id;
    if (!chapterId) return;
    const dialogRef = this.dialog.open(ImageGenDialogComponent, {
      width: '500px',
      data: {
        title: 'Generate Chapter Image',
        suggestLabel: 'Suggest from chapter',
        suggestPrompt: () =>
          this.chapterService
            .suggestImagePrompt(this.editorRef?.getContent() ?? this.chapter()?.content ?? '', this.chapter()?.title)
            .pipe(map(r => r.prompt)),
      } satisfies ImageGenDialogData,
    });
    dialogRef.afterClosed().subscribe((result: ImageGenResult | undefined) => {
      if (!result || this.destroyed) return;
      this.imageUploading.set(true);
      this.chapterService.generateImage(result.prompt).subscribe({
        next: ({ url, thumbnailUrl }) => this.applyChapterImage(url, thumbnailUrl),
        error: () => {
          this.snackBar.open('Image generation failed', undefined, { duration: 3000 });
          this.imageUploading.set(false);
        },
      });
    });
  }

  /** Stores a newly uploaded/generated image on the chapter and persists it. */
  private applyChapterImage(url: string, thumbnailUrl: string): void {
    this.imageUrl.set(url);
    this.imageThumbnailUrl.set(thumbnailUrl);
    const current = this.chapter();
    if (!current) { this.imageUploading.set(false); return; }
    const updated = { ...current, imageUrl: url, imageThumbnailUrl: thumbnailUrl };
    this.chapter.set(updated);
    this.chapterService.update(updated).subscribe({
      next: () => {
        this.imageUploading.set(false);
        this.recordRecentChapter();
        this.snackBar.open('Chapter image saved', undefined, { duration: 2500 });
      },
      error: () => {
        this.imageUploading.set(false);
        this.snackBar.open('Image saved to storage but chapter save failed — click Save to retry', undefined, { duration: 4000 });
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

  private recordRecentChapter(): void {
    const chapter = this.chapter();
    if (!chapter || !this.bookTitle() || !this.seriesTitle()) return;
    const thumbFilename = this.imageThumbnailUrl()?.split('/').pop();
    this.recentChapters.record({
      chapterId: chapter.id,
      chapterTitle: chapter.title || 'Chapter',
      bookTitle: this.bookTitle(),
      seriesTitle: this.seriesTitle(),
      thumbnailUrl: thumbFilename ? `/api/image/${thumbFilename}` : undefined,
    });
  }

  updateTitle(value: string): void {
    const current = this.chapter();
    if (!current) return;
    this.chapter.set({ ...current, title: value });
    if (this.bookMode()) {
      const slot = this.bookSlots.get(current.id);
      if (slot) slot.chapter = { ...slot.chapter, title: value };
      this.bookChapters.update(list => list.map(c => (c.id === current.id ? { ...c, title: value } : c)));
      this.markDirty(current.id);
      this.updateHeader();
    }
  }

  // ── Chapter details (POV / setting / story-time) ──────────────────────────

  /** Updates a free-text detail field locally; persisted on blur via persistMeta. */
  updateMetaField(field: 'setting' | 'inStoryTime', value: string): void {
    const current = this.chapter();
    if (current) this.chapter.set({ ...current, [field]: value });
  }

  /** Sets the POV character and persists immediately (selects don't blur predictably). */
  updatePov(entityId: string): void {
    const current = this.chapter();
    if (!current) return;
    this.chapter.set({ ...current, povEntityId: entityId || undefined });
    this.persistMeta();
  }

  /** Persists detail fields without creating a version snapshot, preserving the
   *  live editor content/notes/outline (mirrors save() minus the version). */
  persistMeta(): void {
    const current = this.chapter();
    if (!current) return;
    const content = this.editorRef?.getContent() ?? current.content ?? '';
    this.chapterService.update({ ...current, content, notes: this.notes(), outline: this.outline() }).subscribe({
      error: () => this.snackBar.open('Failed to save chapter details — click Save to retry', undefined, { duration: 4000 }),
    });
  }

  async save(): Promise<void> {
    if (this.bookMode()) return this.saveBook();
    const chapter = this.chapter();
    if (!chapter || !chapter.title.trim()) return;

    if (this.autoSaveTimer) { clearTimeout(this.autoSaveTimer); this.autoSaveTimer = null; }

    // Strip entity-quote spans and transient seek highlights before saving
    if (this.editorRef) {
      this.editorRef.unwrapEntityQuotes();
      this.editorRef.clearEntitySeekHighlight();
    }
    const content = this.editorRef?.getContent() ?? chapter.content ?? '';

    this.saving.set(true);
    const outline = this.outline().filter(item => item.text.trim() !== '');
    const toSave = { ...chapter, content, notes: this.notes(), outline };

    this.chapterService.update(toSave).subscribe({
      next: async (saved) => {
        this.chapterVersionService.create(
          chapter.id, content,
          this.userSettings.displayName() || this.authService.currentUser()?.name || undefined,
        ).subscribe();

        this.historyPanel()?.refreshAfterSave();
        await this.draftService.clearDraft(chapter.id);
        this.hasDraft.set(false);
        this.lastSavedContent = content;
        this.saving.set(false);
        this.recordRecentChapter();
        this.notifyContentWarnings(saved.contentWarnings);
        this.checkTaskFulfillment(chapter.id, content);
      },
      error: () => this.saving.set(false),
    });
  }

  /**
   * After a save, asks the server whether the changes since the last check
   * may have finished any of this book's open tasks, and if so offers to
   * complete them. Runs in the background; failures are silent.
   */
  private checkTaskFulfillment(chapterId: string, content: string): void {
    const baseline = this.taskCheckBaseline;
    if (baseline === null || baseline === content || this.taskCheckInFlight) return;
    this.taskCheckInFlight = true;
    this.tasksService.checkChapter(chapterId, baseline, content, [...this.declinedTaskIds]).subscribe({
      next: ({ candidates }) => {
        this.taskCheckInFlight = false;
        // The author may have moved to another chapter while the check ran.
        if (this.chapter()?.id !== chapterId) return;
        this.taskCheckBaseline = content;
        if (!candidates.length) return;
        const ref = this.dialog.open<TaskFulfillmentDialogComponent, TaskFulfillmentDialogData, TaskFulfillmentDialogResult>(
          TaskFulfillmentDialogComponent,
          { data: { candidates }, width: '480px', maxHeight: '80vh', autoFocus: 'dialog' },
        );
        ref.afterClosed().subscribe(chosen => {
          const ids = new Set(chosen ?? []);
          for (const c of candidates) if (!ids.has(c.taskId)) this.declinedTaskIds.add(c.taskId);
          if (!ids.size) return;
          forkJoin([...ids].map(id => this.tasksService.setCompleted(id, true, chapterId))).subscribe({
            next: () =>
              this.snackBar.open(ids.size === 1 ? 'Task completed' : `${ids.size} tasks completed`, undefined, { duration: 3000 }),
            error: () => this.snackBar.open('Couldn’t complete the task — try from the Tasks page', undefined, { duration: 5000 }),
          });
        });
      },
      error: () => {
        this.taskCheckInFlight = false;
      },
    });
  }

  /** Shows a dismissible toast when a save left some paragraphs out of the
   *  search index (Azure content filter), with a "Details" action that lists
   *  the offending text so the author can find and address it. */
  private notifyContentWarnings(warnings: ContentFilterWarning[] | undefined): void {
    if (!warnings || warnings.length === 0) {
      this.snackBar.open('Chapter saved', undefined, { duration: 3000 });
      return;
    }
    const count = warnings.length;
    const ref = this.snackBar.open(
      `Chapter saved — ${count} paragraph${count === 1 ? '' : 's'} couldn't be added to the search index`,
      'Details',
      { duration: 8000 },
    );
    ref.onAction().subscribe(() => {
      this.dialog.open(ContentWarningsDialogComponent, {
        data: { warnings } satisfies ContentWarningsDialogData,
        width: '480px',
        maxHeight: '80vh',
      });
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
          this.mentionContent.set(data.content ?? '');
          const slot = this.bookSlots.get(data.id);
          if (slot) {
            Object.assign(slot, makeSlot(data, data.content ?? '', data.notes ?? [], data.outline ?? [], false, data.content ?? ''));
            this.bookChapters.update(list => list.map(c => (c.id === data.id ? { id: data.id, title: data.title, content: data.content ?? '' } : c)));
            this.dirtyChapterIds.update(set => new Set([...set].filter(x => x !== data.id)));
          }
        },
      });
    });
  }

  viewDraftDiff(): void {
    const draftContent = this.editorRef?.getContent() ?? this.chapter()?.content ?? '';
    const data: DraftDiffDialogData = { savedContent: this.lastSavedContent ?? '', draftContent };
    this.dialog.open(DraftDiffDialogComponent, { data, width: '640px', maxWidth: '90vw' });
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
    this.scheduleNotesDraftSave();

    this.dismissNoteInput();
  }

  /** Add a general chapter note not tied to any selected passage. Opens it for
   *  editing immediately; it is discarded if left empty (see cancelEditNote). */
  addGeneralNote(): void {
    const note: ChapterNote = {
      id: crypto.randomUUID(),
      noteText: '',
      selectedText: '',
      createdAt: new Date().toISOString(),
      createdBy: this.authService.currentUser()?.email || undefined,
      createdByName: this.userSettings.displayName() || undefined,
    };
    this.notes.update(ns => [...ns, note]);
    this.startEditNote(note);
  }

  /** Wraps notes added at the read-aloud play head (from AI chat or Siri)
   *  around the word being read (else their paragraph's last word), so they
   *  work like any in-text note. A note whose paragraph can't be found
   *  becomes a general chapter note. Works on the
   *  chapter in scope; in full-book mode that's the active chapter, once its
   *  editor has mounted. */
  private pinAnchoredNotes(): void {
    const editor = this.editorRef;
    if (!editor || !this.notes().some(n => n.anchor)) return;
    this.notes.update(ns => ns.map(n => {
      if (!n.anchor) return n;
      const wrapped = editor.wrapAnchoredNote(n.id, n.anchor);
      const { anchor: _pinned, ...rest } = n;
      // The highlighted word is what the note is "on"; keep the stored quote if nothing was found.
      return { ...rest, selectedText: wrapped ? noteAnchorExcerpt(wrapped) : n.selectedText };
    }));
    this.scheduleNotesDraftSave();
  }

  /** Debounced draft save reflecting the current notes and outline. */
  private scheduleNotesDraftSave(): void {
    const current = this.chapter();
    if (!current) return;
    this.markDirty(current.id);
    const content = this.editorRef?.getContent() ?? '';
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      this.draftService.saveDraft(current.id, content, this.notes(), this.outline());
      this.hasDraft.set(true);
    }, 800);
  }

  // ── Notes: inline click-to-edit ──────────────────────────────────────────

  startEditNote(note: ChapterNote, event?: Event): void {
    event?.stopPropagation();
    this.editingNoteId.set(note.id);
    this.editingNoteText.set(note.noteText);
    setTimeout(() => {
      const el = this.editNoteEl?.nativeElement;
      el?.focus();
      el?.select();
    });
  }

  saveEditNote(): void {
    const id = this.editingNoteId();
    if (!id) return;
    const text = this.editingNoteText().trim();
    // Empty text is treated as a cancel (drops never-saved notes, keeps existing ones).
    if (!text) { this.cancelEditNote(); return; }
    this.notes.update(ns => ns.map(n => (n.id === id ? { ...n, noteText: text } : n)));
    this.editingNoteId.set(null);
    this.editingNoteText.set('');
    this.scheduleNotesDraftSave();
  }

  cancelEditNote(): void {
    const id = this.editingNoteId();
    if (id) {
      // Drop a note that was never given any text (e.g. a general note added then cancelled).
      this.notes.update(ns => ns.filter(n => n.id !== id || n.noteText.trim() !== ''));
    }
    this.editingNoteId.set(null);
    this.editingNoteText.set('');
  }

  onEditNoteKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); this.cancelEditNote(); }
    else if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); this.saveEditNote(); }
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
    if (this.editingNoteId() === noteId) this.cancelEditNote();
    this.notes.update(ns => ns.filter(n => n.id !== noteId));
    this.editorRef?.removeNoteSpan(noteId);
    this.scheduleNotesDraftSave();
  }

  scrollToNote(noteId: string): void {
    this.highlightedNoteId.set(noteId);
    this.editorRef?.scrollToNoteSpan(noteId);
    setTimeout(() => this.highlightedNoteId.set(null), 2100);
  }

  async loadLinkedChats(chapterId: string): Promise<void> {
    this.linkedChatsLoading.set(true);
    const chats = await this.quickChat.getLinkedChats(chapterId);
    this.linkedChats.set(chats);
    this.linkedChatsLoading.set(false);
  }

  openLinkedChat(sessionId: string): void {
    void this.quickChat.loadSession(sessionId, true);
  }

  startLinkedChat(): void {
    const chapterId = this.chapter()?.id;
    if (!chapterId) return;
    void this.quickChat.startLinkedChat(chapterId).then(() => {
      void this.loadLinkedChats(chapterId);
    });
  }

  unlinkChat(sessionId: string): void {
    const chapterId = this.chapter()?.id;
    void this.quickChat.unpinSession(sessionId).then(() => {
      if (chapterId) void this.loadLinkedChats(chapterId);
    });
  }

  toggleNotesList(): void { this.activateSidebarTab(0); }

  // ── Find-in-page search ──────────────────────────────────────────────────

  openSearch(scope: 'chapter' | 'book' = 'chapter'): void {
    const wasVisible = this.searchVisible();
    this.searchVisible.set(true);
    if (scope !== this.searchScope() || !wasVisible) this.setSearchScope(scope);
    setTimeout(() => {
      this.searchInputEl?.nativeElement?.focus();
      this.searchInputEl?.nativeElement?.select();
    });
  }

  /** Switches the find bar between this chapter and the whole book, re-running
   *  the current query in the new scope. */
  setSearchScope(scope: 'chapter' | 'book'): void {
    const effective = scope === 'book' && !this.bookMode() ? 'chapter' : scope;
    this.clearAllSearchHighlights();
    this.searchScope.set(effective);
    this.searchLocation.set('');
    if (this.searchQuery()) this.onSearchQueryChange(this.searchQuery());
  }

  closeSearch(): void {
    this.searchVisible.set(false);
    this.searchQuery.set('');
    this.searchMatchCount.set(0);
    this.searchMatchIndex.set(0);
    this.searchLocation.set('');
    this.bookSearchCounts = [];
    if (this.bookSearchTimer) { clearTimeout(this.bookSearchTimer); this.bookSearchTimer = null; }
    this.clearAllSearchHighlights();
    this.editorRef?.focus();
  }

  private clearAllSearchHighlights(): void {
    const editors = this.bookMode() ? this.bookEditor()?.mountedEditors() ?? [] : [this.editorRef];
    for (const editor of editors) editor?.clearSearchHighlights();
  }

  private get isBookSearch(): boolean {
    return this.searchScope() === 'book' && this.bookMode();
  }

  /** Counts matches in every chapter (stored text for unmounted chapters,
   *  live text for mounted ones) and jumps to the first one at or after the
   *  chapter being read. */
  private runBookSearch(): void {
    const query = this.searchQuery();
    this.clearAllSearchHighlights();
    if (!query.trim()) {
      this.bookSearchCounts = [];
      this.searchMatchCount.set(0);
      this.searchMatchIndex.set(0);
      this.searchLocation.set('');
      return;
    }
    const activeId = this.chapter()?.id;
    this.bookSearchCounts = this.bookChapters().map(c => {
      const live = this.bookEditor()?.editorFor(c.id)?.getContent();
      const html = live ?? this.bookSlots.get(c.id)?.content ?? c.content;
      return { id: c.id, count: countMatches(this.bookTextIndex.runsFor(c.id, html), query) };
    });
    const counts = this.bookSearchCounts.map(c => c.count);
    const total = counts.reduce((a, b) => a + b, 0);
    this.searchMatchCount.set(total);
    if (total === 0) { this.searchMatchIndex.set(0); this.searchLocation.set(''); return; }
    const start = firstMatchFrom(counts, Math.max(0, this.bookSearchCounts.findIndex(c => c.id === activeId)));
    this.searchMatchIndex.set(start);
    void this.showBookMatch(start);
  }

  /** Brings a book-wide match on screen: moves to its chapter (mounting the
   *  editor if needed), highlights the chapter's matches and scrolls to it. */
  private async showBookMatch(global: number): Promise<void> {
    const query = this.searchQuery();
    const where = locateMatch(this.bookSearchCounts.map(c => c.count), global);
    if (!where) return;
    const entry = this.bookSearchCounts[where.chapter]!;
    if (entry.id !== this.chapter()?.id) {
      this.clearAllSearchHighlights();
      this.bookEditor()?.scrollToChapter(entry.id);
      this.activateBookChapter(entry.id);
    }
    const editor = await this.waitForBookEditor(entry.id);
    if (!editor || this.searchQuery() !== query || !this.searchVisible()) return;
    const live = editor.highlightSearchMatches(query);
    if (live !== entry.count) {
      // The live text can differ slightly from the stored text (e.g. a match
      // split by a grammar mark); keep the totals honest.
      this.searchMatchCount.update(t => t + live - entry.count);
      entry.count = live;
    }
    if (live > 0) editor.scrollToSearchMatch(Math.min(where.local, live - 1));
    const title = this.bookChapters()[where.chapter]?.title || 'Untitled chapter';
    this.searchLocation.set(`Ch. ${where.chapter + 1} — ${title}`);
  }

  private async waitForBookEditor(id: string): Promise<RichTextEditorComponent | undefined> {
    for (let i = 0; i < 60; i++) {
      const editor = this.bookEditor()?.editorFor(id);
      if (editor?.getEditorElement()?.isConnected) return editor;
      await new Promise(r => requestAnimationFrame(r));
    }
    return undefined;
  }

  onSearchQueryChange(query: string): void {
    this.searchQuery.set(query);
    if (this.isBookSearch) {
      if (this.bookSearchTimer) clearTimeout(this.bookSearchTimer);
      this.bookSearchTimer = setTimeout(() => { this.bookSearchTimer = null; this.runBookSearch(); }, 150);
      return;
    }
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
    if (this.isBookSearch) void this.showBookMatch(next);
    else this.editorRef?.scrollToSearchMatch(next);
  }

  prevSearchMatch(): void {
    const count = this.searchMatchCount();
    if (count === 0) return;
    const prev = (this.searchMatchIndex() - 1 + count) % count;
    this.searchMatchIndex.set(prev);
    if (this.isBookSearch) void this.showBookMatch(prev);
    else this.editorRef?.scrollToSearchMatch(prev);
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
          if (this.bookMode()) this.offerNextChapter('analyze', 'Nothing new found in this chapter');
          else this.snackBar.open('Nothing new found — everything is up to date', undefined, { duration: 4000 });
          return;
        }
        const ref = this.dialog.open(ChapterAnalysisDialogComponent, {
          data: { timeline: { ...timeline, entities: this.entities() }, relationships } satisfies ChapterAnalysisDialogData,
          autoFocus: false,
          maxHeight: '85vh',
        });
        ref.afterClosed().subscribe((selection?: ChapterAnalysisDialogResult) => {
          if (!selection) { this.offerNextChapter('analyze'); return; }
          const { timeline: tl, relationships: rel } = selection;
          const hasTl = tl.adds.length + tl.updates.length + tl.removes.length > 0;
          const hasRel = rel.adds.length > 0;
          if (!hasTl && !hasRel) { this.offerNextChapter('analyze'); return; }

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
            if (this.bookMode()) this.offerNextChapter('analyze', summary ? `Applied: ${summary}` : undefined);
            else if (summary) this.snackBar.open(`Applied: ${summary}`, undefined, { duration: 4000 });
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

  // ── Fact check ───────────────────────────────────────────────────────────

  /** Fact-checks the real-world claims in this chapter, streaming findings into
   *  the report panel as they settle. Progress rides in a snack bar so the
   *  editor stays usable throughout. Read-only: nothing is saved and the prose
   *  is never modified. */
  factCheckChapter(): void {
    const chapter = this.chapter();
    if (!chapter || this.factChecking()) return;
    const text = this.stripHtml(this.editorRef?.getContent() ?? chapter.content ?? '');
    if (!text.trim()) {
      this.snackBar.open('Chapter is empty — nothing to fact-check', undefined, { duration: 3000 });
      return;
    }

    this.openFactCheckPanel();
    this.factCheckToast = this.snackBar.openFromComponent(FactCheckToastComponent, {
      data: {
        onView: () => this.openFactCheckPanel(),
        onStop: () => this.factCheckService.stop(),
      } satisfies FactCheckToastData,
      // Stays until the run ends — it is the run's only status indicator when
      // the report panel is closed.
      politeness: 'polite',
      horizontalPosition: 'right',
    });

    // Entity names tell the check which people and places are invented, so it
    // doesn't report the story's own world as factually wrong.
    const entityNames = this.entities().map(e => e.name).filter(Boolean);
    void this.factCheckService.run(text, entityNames).then(() => void this.onFactCheckFinished());
  }

  /** Swaps the progress toast for the finished report once a run settles, and
   *  keeps the run: a finished check is saved against the chapter so the author
   *  can come back to it and tick findings off as they deal with them. */
  private async onFactCheckFinished(): Promise<void> {
    this.factCheckToast?.dismiss();
    this.factCheckToast = undefined;
    if (this.destroyed) return;

    // A run with nothing to save has to clear itself, or the panel keeps
    // showing that empty run in place of the saved reports behind it.
    const error = this.factCheckService.error();
    if (error) {
      this.snackBar.open(error, undefined, { duration: 6000 });
      this.factCheckService.reset();
      return;
    }
    const count = this.factCheckService.findings().length;
    if (count === 0) {
      const stopped = this.factCheckService.stopped();
      const message = stopped ? 'Fact check stopped — nothing was checked' : 'No real-world claims found in this chapter';
      this.factCheckService.reset();
      if (!stopped && this.bookMode()) this.offerNextChapter('factCheck', message);
      else this.snackBar.open(message, undefined, { duration: 4000 });
      return;
    }
    // A stopped run is the author's decision to look away, so don't shove the
    // panel in front of them — just say where the partial report is.
    const stoppedEarly = this.factCheckService.stopped();
    await this.saveFactCheckRun();
    if (this.destroyed) return;

    if (stoppedEarly && !this.factCheckPanelOpen()) {
      const ref = this.snackBar.open(
        `Fact check stopped — ${count} ${count === 1 ? 'claim' : 'claims'} checked and saved`,
        'View report',
        { duration: 8000 },
      );
      ref.onAction().subscribe(() => this.openFactCheckPanel());
      return;
    }
    this.openFactCheckPanel();
    if (!stoppedEarly) this.offerNextChapter('factCheck', `Fact check done — ${count} ${count === 1 ? 'claim' : 'claims'} checked`);
  }

  /** Saves the run just finished, then clears the live report so the panel
   *  shows the saved, checkable copy instead. A failed save leaves the live
   *  report up — the panel says so — rather than losing the findings silently. */
  private async saveFactCheckRun(): Promise<void> {
    const chapter = this.chapter();
    if (!chapter) return;
    const saved = await this.factCheckReports.saveRun({
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      runAt: new Date().toISOString(),
      findings: this.factCheckService.findings(),
      total: this.factCheckService.total(),
      truncated: this.factCheckService.truncated(),
      stopped: this.factCheckService.stopped(),
      searchAvailable: this.factCheckService.searchAvailable(),
    });
    if (saved) this.factCheckService.reset();
  }



  /** True when the Fact Check tab is the selected sidebar tab. */
  private factCheckPanelOpen(): boolean {
    return this.sidebarTabIndex() === ChapterEditComponent.FACT_CHECK_TAB;
  }

  /** Scrolls the editor to the passage a fact-check finding came from and
   *  flashes it. The prose can have moved on since the check ran, so a passage
   *  that is no longer there is reported rather than silently doing nothing. */
  revealChapterPassage(passage: string): void {
    if (!this.editorRef?.highlightPassage(passage)) {
      this.snackBar.open(
        "That passage isn't in the chapter any more — it may have been edited since this check ran.",
        'OK',
        { duration: 5000 },
      );
    }
  }

  /** Brings the Fact Check sidebar tab to the front. On mobile the sidebar is
   *  left as the author had it — same as starting a Quill review — because
   *  sliding it up unprompted would cover the chapter they're reading. */
  private openFactCheckPanel(): void {
    this.setSidebarCollapsed(false);
    this.onSidebarTabChange(ChapterEditComponent.FACT_CHECK_TAB);
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

  /** Closes whichever card's inline editor is open, returning to the full list. */
  closeSuggestionEditing(): void {
    this.pendingSuggestions.update(list =>
      list.map(c => c.creating ? { ...c, creating: false, draftEntity: undefined } : c),
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

  /** Keeps the entity list in sync with a photo saved mid-edit, without resetting the form. */
  onEntityPhotoSaved(saved: Entity): void {
    this.entities.update(list => list.map(e => e.id === saved.id ? saved : e));
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

  // ── Quill Editor (AI review pass) ─────────────────────────────────────────

  /** Starts an AI editorial pass: snapshots the chapter into blocks, locks the
   *  editor so anchors can't drift, and streams suggestions into the sidebar. */
  startQuillReview(): void {
    const chapter = this.chapter();
    if (!chapter || !this.editorRef || this.editorReview.running()) return;
    const blocks = this.editorRef.extractReviewBlocks();
    if (blocks.length === 0) {
      this.snackBar.open('Nothing to review yet — write some prose first.', 'OK', { duration: 3000 });
      return;
    }
    this.quillPanel()?.resetDecorations();
    this.editorRef.setEditable(false);
    this.setSidebarCollapsed(false);
    this.onSidebarTabChange(ChapterEditComponent.QUILL_REVIEW_TAB);
    void this.editorReview.run(chapter.id, blocks);
  }

  /** Document→sidebar hover sync (from the editor's hover output). */
  onInlineReviewHovered(id: string | null): void {
    this.quillHoveredId.set(id);
  }

  /** Accept/reject invoked from a decoration's inline popover. */
  onInlineReviewAction(event: { id: string; action: 'accept' | 'reject' }): void {
    this.quillPanel()?.handleInlineAction(event);
  }

  onRightPanelChange(open: boolean): void {
    if (!open) {
      this.editingEntity.set(null);
      this.showAiStats.set(false);
    }
  }

  private stripHtml(html: string): string {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.innerText || div.textContent || '').trim();
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────

  onSidebarTabChange(index: number): void {
    this.sidebarTabIndex.set(index);
  }

  activateSidebarTab(index: number): void {
    if (this.mobileSidebarOpen() && this.sidebarTabIndex() === index) this.mobileSidebarOpen.set(false);
    else { this.onSidebarTabChange(index); this.mobileSidebarOpen.set(true); }
  }

  toggleSidebarCollapsed(): void {
    this.setSidebarCollapsed(!this.sidebarCollapsed());
  }

  setSidebarCollapsed(collapsed: boolean): void {
    if (this.sidebarCollapsed() === collapsed) return;
    this.sidebarCollapsed.set(collapsed);
    writeSidebarCollapsed(localStorage, collapsed);
  }

  private loadSidebarCollapsed(): void {
    this.sidebarCollapsed.set(readSidebarCollapsed(localStorage));
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

export interface ContentWarningsDialogData {
  warnings: ContentFilterWarning[];
}

@Component({
  selector: 'app-content-warnings-dialog',
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>Paragraphs left out of the search index</h2>
    <mat-dialog-content>
      <p class="intro">
        Azure's content filter flagged the paragraphs below, so they weren't embedded for
        Ask Quill's chapter search. The rest of the chapter saved and indexed normally.
      </p>
      @for (warning of data.warnings; track $index) {
        <blockquote class="warning-preview">{{ warning.preview }}</blockquote>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-flat-button [mat-dialog-close]="true">Got it</button>
    </mat-dialog-actions>
  `,
  styles: `
    .intro { margin-top: 0; }
    .warning-preview {
      margin: 0 0 12px;
      padding: 8px 12px;
      border-left: 3px solid var(--mat-sys-error, #b3261e);
      background: rgba(0, 0, 0, 0.04);
      font-style: italic;
      white-space: pre-wrap;
    }
  `,
})
export class ContentWarningsDialogComponent {
  data = inject<ContentWarningsDialogData>(MAT_DIALOG_DATA);
}

/** One chapter's state while the full book is open. */
interface BookSlot {
  chapter: Chapter;
  /** Latest HTML (live editor content is read back on every switch/save). */
  content: string;
  notes: ChapterNote[];
  outline: OutlineItem[];
  /** Has an unsaved local draft. */
  hasDraft: boolean;
  /** Content as of the last server save. */
  savedContent: string;
  /** Content as of the last local draft write. */
  draftContent: string;
  taskCheckBaseline: string | null;
}

function makeSlot(
  chapter: Chapter, content: string, notes: ChapterNote[], outline: OutlineItem[],
  hasDraft: boolean, savedContent: string,
): BookSlot {
  return {
    chapter: { ...chapter, content }, content, notes, outline, hasDraft, savedContent,
    draftContent: hasDraft ? content : savedContent, taskCheckBaseline: savedContent,
  };
}
