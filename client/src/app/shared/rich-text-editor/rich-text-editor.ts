import {
  Component, inject, signal, computed, effect, untracked,
  OnInit, AfterViewInit, OnDestroy, ViewChild, ElementRef, HostListener, input, output,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Entity, EntityReference } from '@shared/models/entity.model';
import { EntityService } from '../../services/entity.service';
import { GrammarCheckService, GrammarError, SuggestedEntity } from '../../services/grammar-check.service';
import { UserSettingsService } from '../../services/user-settings.service';

/** Minimal shape the editor needs to decorate/act on a Quill Editor suggestion.
 *  Structurally compatible with the review service's `ReviewSuggestion`. */
export interface ReviewDecoration {
  id: string;
  blockIndex: number;
  originalText: string;
  replacementText?: string;
  type?: string;
  category?: string;
  severity?: string;
  reason?: string;
}

export interface SuggestedEntityCard {
  name: string;
  type: 'PERSON' | 'PLACE' | 'THING';
  description: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  title?: string;
  creating?: boolean;
  created?: boolean;
  draftEntity?: Entity;
}

@Component({
  selector: 'app-rich-text-editor',
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule, DecimalPipe, RouterLink],
  templateUrl: './rich-text-editor.html',
  styleUrl: './rich-text-editor.scss',
})
export class RichTextEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('editorEl') editorRef!: ElementRef<HTMLDivElement>;
  @ViewChild('minimapCanvas') minimapCanvasRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('entityTagInputEl') entityTagInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('photoPickerEntityInputEl') photoPickerEntityInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('photoPickerFileInputEl') photoPickerFileInputRef?: ElementRef<HTMLInputElement>;

  // ── Inputs ──────────────────────────────────────────────────────────────
  seriesId = input<string>('');
  /** Initial HTML content — only read on first render; subsequent changes are
   *  ignored so Angular doesn't fight the contenteditable cursor. */
  initialContent = input<string>('');
  placeholder = input<string>('Start writing…');
  /** SSE endpoint for inline AI.  Defaults to /api/chat/general. */
  aiEndpoint = input<string>('');
  /** When provided, the component uses these entities instead of loading from seriesId. */
  externalEntities = input<Entity[] | null>(null);
  /** Extra context menu items beyond the built-in AI ones. */
  ctxMenuExtraItems = input<{ id: string; label: string; icon: string }[]>([]);
  /** Show an "Add Note" button in the formatting toolbar. */
  showNoteButton = input<boolean>(false);

  // ── Outputs ─────────────────────────────────────────────────────────────
  /** Debounced (800 ms) clean HTML whenever content changes. */
  contentChange = output<string>();
  /** User clicked "edit" on an entity hover popup. */
  entityEditRequest = output<Entity>();
  /** Grammar check discovered new entity suggestions. */
  pendingSuggestionsChange = output<SuggestedEntityCard[]>();
  /** User clicked "Add Note" in the formatting toolbar. */
  noteRequest = output<void>();
  /** An extra ctx-menu item was selected; includes captured text context. */
  ctxMenuExtraItemSelected = output<{ id: string; captureText: string; narratorCaptureText: string; surroundingText: string }>();
  /** User invoked AI assist (long-press or ctx-menu "AI Insert/Reword"). The host
   *  opens the Ask Quill overlay; the captured cursor context travels via the
   *  editor bridge. */
  aiAssistRequested = output<{ selectedText: string; surroundingText: string }>();

  /** Quill Editor: the suggestion currently hovered in the document (or null). */
  reviewSuggestionHovered = output<string | null>();
  /** Quill Editor: accept/reject invoked from a decoration's inline popover. */
  reviewSuggestionAction = output<{ id: string; action: 'accept' | 'reject' }>();

  // ── Internal entity state ────────────────────────────────────────────────
  readonly entities = signal<Entity[]>([]);
  private suggestedEntityNames = new Set<string>();
  readonly pendingSuggestions = signal<SuggestedEntityCard[]>([]);

  // ── Autocomplete ─────────────────────────────────────────────────────────
  autocompleteItems = signal<{ entity: Entity; text: string; isPreferred: boolean }[]>([]);
  autocompleteIndex = signal(0);
  autocompleteTop = signal(0);
  autocompleteLeft = signal(0);
  autocompleteAbove = signal(false);
  private currentWordRange: Range | null = null;

  // ── Formatting toolbar ───────────────────────────────────────────────────
  formattingToolbarVisible = signal(false);
  formattingToolbarTop = signal(0);
  formattingToolbarLeft = signal(0);
  formattingState = signal({
    bold: false, italic: false, underline: false,
    align: '' as 'left' | 'center' | 'right' | 'justify' | '',
  });
  private formattingToolbarShownForImage = false;

  // ── Entity tag panel ─────────────────────────────────────────────────────
  entityTagPanelVisible = signal(false);
  entityTagPanelTop = signal(0);
  entityTagPanelLeft = signal(0);
  entityTagSearchQuery = signal('');
  entityTagFocusIndex = signal(0);
  entityTagFilteredEntities = computed(() => {
    const q = this.entityTagSearchQuery().toLowerCase().trim();
    if (!q) return this.entities().slice(0, 20);
    return this.entities().filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.nickname?.toLowerCase().includes(q) ||
      e.firstName?.toLowerCase().includes(q) ||
      e.lastName?.toLowerCase().includes(q),
    ).slice(0, 20);
  });
  private entityTagSavedRange: Range | null = null;

  // ── Entity hover popup ───────────────────────────────────────────────────
  hoveredEntity = signal<Entity | null>(null);
  popupTop = signal(0);
  popupLeft = signal(0);
  private popupHideTimer: ReturnType<typeof setTimeout> | null = null;
  private popupShowTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Image resize ─────────────────────────────────────────────────────────
  selectedImage = signal<HTMLImageElement | null>(null);
  imageOverlayRect = signal<{ top: number; left: number; width: number; height: number } | null>(null);
  private resizeDrag: {
    direction: 'e' | 's' | 'se'; startX: number; startY: number;
    startWidth: number; startHeight: number; img: HTMLImageElement;
    moveHandler: (e: MouseEvent) => void; upHandler: () => void;
  } | null = null;

  // ── Context menu (Ctrl+.) ────────────────────────────────────────────────
  ctxMenuVisible = signal(false);
  ctxMenuTop = signal(0);
  ctxMenuLeft = signal(0);
  ctxMenuItems = signal<{ id: string; label: string; icon: string }[]>([]);
  ctxMenuFocusedIndex = signal(0);
  private ctxMenuCaptureText = '';
  private ctxMenuNarratorCaptureText = '';
  private _ctxMenuSurroundingText = '';

  private externalInsertRange: Range | null = null;
  private readonly onDocumentSelectionChange = (): void => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const editorEl = this.editorRef?.nativeElement;
    if (editorEl?.contains(range.commonAncestorContainer)) {
      this.externalInsertRange = range.cloneRange();
    }
  };

  // ── Grammar ──────────────────────────────────────────────────────────────
  grammarPopoverVisible = signal(false);
  grammarPopoverTop = signal(0);
  grammarPopoverLeft = signal(0);
  grammarPopoverAbove = signal(false);
  grammarPopoverError = signal<GrammarError | null>(null);
  private grammarPopoverMarkEl: HTMLElement | null = null;
  private grammarTimer: ReturnType<typeof setTimeout> | null = null;
  private grammarAbortController: AbortController | null = null;
  private grammarLastCheckedText = '';

  // ── Photo picker panel ────────────────────────────────────────────────────
  photoPickerVisible = signal(false);
  photoPickerTop = signal(0);
  photoPickerLeft = signal(0);
  photoPickerAbove = signal(false);
  photoPickerStep = signal<'entity' | 'source' | 'gallery' | 'upload'>('entity');
  photoPickerEntityQuery = signal('');
  photoPickerSelectedEntity = signal<Entity | null>(null);
  photoPickerEntityFocusIndex = signal(0);
  photoPickerFilteredEntities = computed(() => {
    const q = this.photoPickerEntityQuery().toLowerCase().trim();
    if (!q) return this.entities().slice(0, 20);
    return this.entities().filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.nickname?.toLowerCase().includes(q) ||
      e.firstName?.toLowerCase().includes(q) ||
      e.lastName?.toLowerCase().includes(q),
    ).slice(0, 20);
  });
  photoPickerGalleryPhotos = computed(() => {
    const entity = this.photoPickerSelectedEntity();
    if (!entity) return [] as NonNullable<Entity['photos']>;
    return (entity.photos ?? []).filter(p => !p.hidden);
  });
  photoPickerUploading = signal(false);
  private photoPickerSavedRange: Range | null = null;
  private photoPickerChangingEl: HTMLElement | null = null;

  // ── Photo reference hover popup ───────────────────────────────────────────
  photoRefPopupVisible = signal(false);
  photoRefPopupTop = signal(0);
  photoRefPopupLeft = signal(0);
  photoRefPopupAbove = signal(false);
  photoRefPopupPhotoUrl = signal('');
  private photoRefHoveredEl: HTMLElement | null = null;
  private photoRefPopupHideTimer: ReturnType<typeof setTimeout> | null = null;
  private photoRefPopupShowTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Word count ──────────────────────────────────────────────────────────
  wordCount = signal(0);

  // ── Internal editor state ────────────────────────────────────────────────
  // ── Minimap ──────────────────────────────────────────────────────────────
  private readonly MINIMAP_WIDTH = 80;
  private minimapDragging = false;
  private minimapRenderTimer: ReturnType<typeof setTimeout> | null = null;
  private minimapResizeObserver: ResizeObserver | null = null;

  private _editorContent = '';
  get editorContent(): string { return this._editorContent; }
  set editorContent(value: string) {
    const needsClean = value.includes('grammar-error') || value.includes('ai-insertion-marker') || value.includes('<font');
    if (needsClean) {
      const div = document.createElement('div');
      div.innerHTML = value;
      div.querySelectorAll('mark.grammar-error').forEach(mark => {
        const parent = mark.parentNode!;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
      });
      div.querySelectorAll('.ai-insertion-marker').forEach(el => el.remove());
      // Chrome sometimes wraps new-paragraph content in <font color="..."> when
      // breaking out of a styled inline span.  Unwrap them so content is clean.
      div.querySelectorAll('font').forEach(font => {
        const parent = font.parentNode!;
        while (font.firstChild) parent.insertBefore(font.firstChild, font);
        parent.removeChild(font);
      });
      this._editorContent = div.innerHTML;
    } else {
      this._editorContent = value;
    }
  }

  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private contentInitialized = false;

  // Guard that re-extracts text Chrome snaps back into an AI span after a sentence boundary.
  private lastEjectedSpan: HTMLElement | null = null;
  private lastEjectedSpanTextLength = 0;

  private entityService = inject(EntityService);
  private grammarService = inject(GrammarCheckService);
  private userSettings = inject(UserSettingsService);

  /**
   * When this component is inside a CSS-transformed ancestor (e.g. a slide-out panel),
   * `position:fixed` elements are positioned relative to that ancestor's coordinate space
   * rather than the viewport. This helper returns the {x, y} offset to subtract from
   * viewport-relative `getBoundingClientRect()` values so popup coordinates are correct.
   */
  private getFixedOffset(): { x: number; y: number } {
    let el: HTMLElement | null = this.editorRef?.nativeElement?.parentElement ?? null;
    while (el) {
      const style = window.getComputedStyle(el);
      const transform = style.transform;
      const filter = style.filter;
      const willChange = style.willChange;
      const isContaining =
        (transform && transform !== 'none') ||
        (filter && filter !== 'none') ||
        (willChange && (willChange.includes('transform') || willChange.includes('filter')));
      if (isContaining) {
        const rect = el.getBoundingClientRect();
        return { x: rect.left, y: rect.top };
      }
      el = el.parentElement;
    }
    return { x: 0, y: 0 };
  }

  constructor() {
    // Load entities from seriesId when no external entities are provided
    effect(() => {
      const id = this.seriesId();
      const external = this.externalEntities();
      if (external !== null) return; // managed externally
      if (!id) { this.entities.set([]); return; }
      untracked(() => {
        this.entityService.getBySeries(id).subscribe({
          next: (list) => {
            const active = list.filter(e => !e.deleted && !e.archived);
            this.entities.set(active);
            const synced = this.syncEntityReferences(this.editorContent, active);
            if (synced !== this.editorContent) {
              this.editorContent = synced;
              if (this.editorRef) this.editorRef.nativeElement.innerHTML = synced;
            }
          },
        });
      });
    });

    // Sync whenever external entities change
    effect(() => {
      const external = this.externalEntities();
      if (external === null) return;
      const active = external.filter(e => !e.deleted && !e.archived);
      this.entities.set(active);
      const synced = this.syncEntityReferences(this.editorContent, active);
      if (synced !== this.editorContent) {
        this.editorContent = synced;
        // Only update DOM if editorRef is available (not during first render)
        if (this.editorRef && this.contentInitialized) this.editorRef.nativeElement.innerHTML = synced;
      }
    });

    // Emit pendingSuggestionsChange whenever the list changes
    effect(() => {
      this.pendingSuggestionsChange.emit(this.pendingSuggestions());
    });

    // When grammar check or entity detection is toggled off, clean up accordingly.
    // Only abort the in-flight request when both are disabled.
    effect(() => {
      const grammarEnabled = this.userSettings.grammarCheckEnabled();
      const entityEnabled = this.userSettings.entityDetectionEnabled();
      if (!grammarEnabled) {
        untracked(() => this.unwrapGrammarMarks());
      }
      if (!grammarEnabled && !entityEnabled) {
        this.grammarAbortController?.abort();
        this.grammarAbortController = null;
        if (this.grammarTimer) { clearTimeout(this.grammarTimer); this.grammarTimer = null; }
      }
    });
  }

  ngOnInit(): void { /* entities loaded via effect */ }

  ngAfterViewInit(): void {
    const content = this.initialContent();
    if (content) this.setContent(content);
    this.minimapResizeObserver = new ResizeObserver(() => this.scheduleMinimap());
    this.minimapResizeObserver.observe(this.editorRef.nativeElement);
    this.scheduleMinimap();
    document.addEventListener('selectionchange', this.onDocumentSelectionChange);
  }

  ngOnDestroy(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.grammarTimer) clearTimeout(this.grammarTimer);
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    if (this.popupHideTimer) clearTimeout(this.popupHideTimer);
    if (this.popupShowTimer) clearTimeout(this.popupShowTimer);
    if (this.minimapRenderTimer) clearTimeout(this.minimapRenderTimer);
    if (this.photoRefPopupHideTimer) clearTimeout(this.photoRefPopupHideTimer);
    if (this.photoRefPopupShowTimer) clearTimeout(this.photoRefPopupShowTimer);
    this.grammarAbortController?.abort();
    this.minimapResizeObserver?.disconnect();
    document.removeEventListener('selectionchange', this.onDocumentSelectionChange);
    if (this.resizeDrag) {
      document.removeEventListener('mousemove', this.resizeDrag.moveHandler);
      document.removeEventListener('mouseup', this.resizeDrag.upHandler);
    }
  }

  // ── Public API (for parents via ViewChild) ───────────────────────────────

  setContent(html: string): void {
    this.contentInitialized = true;
    this.editorContent = html;
    if (this.editorRef) {
      this.editorRef.nativeElement.innerHTML = html;
      this.wordCount.set(this.countWords(this.editorRef.nativeElement.textContent ?? ''));
    }
    setTimeout(() => this.scheduleMinimap());
  }

  private countWords(text: string): number {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  getContent(): string {
    return this.editorContent;
  }

  focus(): void {
    this.editorRef?.nativeElement.focus();
  }

  insertExternalText(text: string): void {
    const editorEl = this.editorRef?.nativeElement;
    if (!editorEl) return;

    let range = this.externalInsertRange?.cloneRange() ?? null;
    if (!range || !editorEl.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editorEl);
      range.collapse(false);
    }
    // Insert at the cursor without replacing any selection: if the tracked range
    // spans a selection, collapse to its end and insert there.
    range.collapse(false);

    const wrapper = document.createElement('span');
    wrapper.setAttribute('data-ai-generated', 'true');
    // Annotate entity names inside the inserted text (matches the old AI Insert).
    wrapper.appendChild(this.buildEntityAnnotatedFragment(text));

    range.insertNode(wrapper);

    const ar = document.createRange();
    ar.setStartAfter(wrapper);
    ar.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(ar); }

    // Arm the eject guard so the user's next keystroke after the span isn't
    // snapped back into it (mirrors the old accept path).
    this.lastEjectedSpan = wrapper;
    this.lastEjectedSpanTextLength = wrapper.textContent?.length ?? 0;

    editorEl.focus();
    this.scrollCursorIntoView();
    this.editorContent = editorEl.innerHTML;
    this.scheduleEmit();
  }

  /** Replaces the ENTIRE editor content with the given plain text, split into
   *  paragraphs on blank lines and entity-annotated (used by "Replace chapter"
   *  on an AI draft). */
  replaceWithText(text: string): void {
    const editorEl = this.editorRef?.nativeElement;
    if (!editorEl) return;

    editorEl.innerHTML = '';
    const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    for (const para of paragraphs) {
      const p = document.createElement('p');
      p.setAttribute('data-ai-generated', 'true');
      // Collapse single newlines inside a paragraph to spaces for clean prose.
      p.appendChild(this.buildEntityAnnotatedFragment(para.replace(/\n+/g, ' ')));
      editorEl.appendChild(p);
    }

    editorEl.focus();
    this.wordCount.set(this.countWords(editorEl.textContent ?? ''));
    this.editorContent = editorEl.innerHTML;
    this.scheduleEmit();
    setTimeout(() => this.scheduleMinimap());
  }

  /** Captures the cursor surroundings for an AI request: the selected text and
   *  the ±300-char context around the caret (with a [CURSOR] marker). Uses the
   *  live selection when it's inside the editor, else the last tracked range. */
  captureAiContext(): { surroundingText: string; selectedText: string } {
    const editorEl = this.editorRef?.nativeElement;
    let range: Range | null = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (editorEl?.contains(r.commonAncestorContainer)) range = r;
    }
    if (!range) range = this.externalInsertRange;
    if (!range) return { surroundingText: '', selectedText: '' };
    return { surroundingText: this.extractSurroundingText(range), selectedText: range.toString() };
  }

  /** Emits the AI-assist request with captured cursor context. The host (chapter
   *  editor) opens the Ask Quill overlay in response. */
  requestAiAssist(): void {
    const { surroundingText, selectedText } = this.captureAiContext();
    this.aiAssistRequested.emit({ selectedText, surroundingText });
  }

  /** Returns focus to the editor at the cursor position it held before focus
   *  moved away (e.g. when an external overlay was dismissed without inserting).
   *  No-op if the editor was never the active caret. */
  restoreFocus(): void {
    const editorEl = this.editorRef?.nativeElement;
    const range = this.externalInsertRange;
    if (!editorEl || !range || !editorEl.contains(range.commonAncestorContainer)) return;
    // preventScroll: focusing a contenteditable otherwise jumps the scroll to the
    // top; the caret is already where the user left it, so keep the viewport put.
    editorEl.focus({ preventScroll: true });
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range.cloneRange()); }
  }

  /** Wrap all occurrences of the given entity's names in entity-reference spans.
   *  Also adds the entity to the internal entities list if not already present. */
  wrapNewEntity(entity: Entity): void {
    this.entities.update(list => list.some(e => e.id === entity.id) ? list : [...list, entity]);
    this.wrapEntityReferencesInEditor(entity);
  }

  /** Sync entity-reference span text after an entity is renamed. */
  syncEntities(entities: Entity[]): void {
    this.entities.set(entities.filter(e => !e.deleted && !e.archived));
    const synced = this.syncEntityReferences(this.editorContent, this.entities());
    if (synced !== this.editorContent) {
      this.editorContent = synced;
      if (this.editorRef) this.editorRef.nativeElement.innerHTML = synced;
    }
  }

  /** Wrap the current selection in a note-indicator span.
   *  Returns the selected plain text (for building the ChapterNote), or null. */
  wrapSelectionWithNote(noteId: string): string | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const selectedText = range.toString();
    const span = document.createElement('span');
    span.className = 'note-indicator';
    span.setAttribute('data-note-id', noteId);
    try {
      range.surroundContents(span);
    } catch {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    if (this.editorRef) this.editorContent = this.editorRef.nativeElement.innerHTML;
    this.scheduleEmit();
    return selectedText;
  }

  removeNoteSpan(noteId: string): void {
    if (!this.editorRef) return;
    const editor = this.editorRef.nativeElement;
    const span = editor.querySelector(`[data-note-id="${noteId}"]`);
    if (!span) return;
    const parent = span.parentNode!;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    this.editorContent = editor.innerHTML;
    this.scheduleEmit();
  }

  scrollToNoteSpan(noteId: string): void {
    if (!this.editorRef) return;
    const span = this.editorRef.nativeElement.querySelector<HTMLElement>(`[data-note-id="${noteId}"]`);
    if (!span) return;
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    span.classList.add('note-highlighted');
    setTimeout(() => span.classList.remove('note-highlighted'), 2000);
  }

  /** Strip entity-quote spans before persisting (chapter-specific concern). */
  unwrapEntityQuotes(): void {
    if (!this.editorRef) return;
    const editor = this.editorRef.nativeElement;
    const quotes = editor.querySelectorAll('span.entity-quote');
    if (quotes.length === 0) return;
    quotes.forEach(span => {
      const parent = span.parentNode!;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    });
    editor.normalize();
  }

  getEditorElement(): HTMLDivElement | null {
    return this.editorRef?.nativeElement ?? null;
  }

  // ── Quill Editor review (AI editorial pass) ───────────────────────────────

  private reviewHighlightEl: HTMLElement | null = null;
  /** Full suggestion data for each decoration currently in the document. */
  private reviewSuggestions = new Map<string, ReviewDecoration>();
  /** The suggestion id last reported as hovered, to debounce repeat emits. */
  private hoveredReviewId: string | null = null;

  // Inline accept/reject popover (mirrors the grammar popover pattern).
  reviewPopoverVisible = signal(false);
  reviewPopoverTop = signal(0);
  reviewPopoverLeft = signal(0);
  reviewPopoverAbove = signal(false);
  reviewPopoverData = signal<ReviewDecoration | null>(null);

  /** Lock/unlock the editor. The chapter is made read-only while a review run
   *  is active so suggestion anchors can't drift under the author's cursor. */
  setEditable(editable: boolean): void {
    const el = this.editorRef?.nativeElement;
    if (el) el.setAttribute('contenteditable', editable ? 'true' : 'false');
  }

  /** Wraps a suggestion's target text in a decoration span (text content is
   *  left untouched, so anchoring stays stable as more decorations are added).
   *  Returns false when the anchor can't be located or wrapped. */
  decorateSuggestion(s: ReviewDecoration): boolean {
    const el = this.editorRef?.nativeElement;
    const block = el?.children[s.blockIndex];
    if (!el || !block) return false;
    if (block.querySelector(`.quill-suggestion-mark[data-suggestion-id="${s.id}"]`)) {
      this.reviewSuggestions.set(s.id, s);
      return true; // already decorated
    }
    const range = this.locateRangeInBlock(block, s.originalText);
    if (!range) return false;
    const span = document.createElement('span');
    span.className = 'quill-suggestion-mark';
    span.setAttribute('data-suggestion-id', s.id);
    span.setAttribute('data-severity', s.severity ?? 'medium');
    span.setAttribute('data-type', s.type === 'comment' ? 'comment' : 'replace');
    try {
      range.surroundContents(span);
    } catch {
      return false; // range crosses element boundaries
    }
    this.reviewSuggestions.set(s.id, s);
    return true;
  }

  /** Removes a decoration, restoring the original text unchanged. */
  undecorateSuggestion(id: string): void {
    this.reviewSuggestions.delete(id);
    if (this.reviewPopoverData()?.id === id) this.hideReviewPopover();
    const span = this.editorRef?.nativeElement
      .querySelector<HTMLElement>(`.quill-suggestion-mark[data-suggestion-id="${id}"]`);
    if (span) this.unwrapElement(span);
  }

  /** Applies a suggestion's replacement and removes its decoration. Falls back
   *  to a fresh locate when the decoration is missing. Returns success. */
  acceptSuggestionEdit(s: ReviewDecoration): boolean {
    const el = this.editorRef?.nativeElement;
    if (!el) return false;
    this.reviewSuggestions.delete(s.id);
    if (this.reviewPopoverData()?.id === s.id) this.hideReviewPopover();
    const span = el.querySelector<HTMLElement>(`.quill-suggestion-mark[data-suggestion-id="${s.id}"]`);
    if (span) {
      span.textContent = s.replacementText ?? '';
      this.unwrapElement(span);
    } else {
      const block = el.children[s.blockIndex];
      if (!block) return false;
      const range = this.locateRangeInBlock(block, s.originalText);
      if (!range) return false;
      range.deleteContents();
      range.insertNode(document.createTextNode(s.replacementText ?? ''));
    }
    this.commitCleanContent();
    return true;
  }

  /** Returns the normalized text of a review block (matches extractReviewBlocks),
   *  used as context when refining a suggestion. */
  getReviewBlockText(blockIndex: number): string {
    const block = this.editorRef?.nativeElement.children[blockIndex];
    return (block?.textContent ?? '').replace(/ /g, ' ').trim();
  }

  /** Refreshes the stored data for a decoration after it's been refined, so the
   *  inline popover reflects the new replacement/reason. */
  updateReviewSuggestion(s: ReviewDecoration): void {
    if (this.reviewSuggestions.has(s.id)) this.reviewSuggestions.set(s.id, s);
    if (this.reviewPopoverData()?.id === s.id) this.reviewPopoverData.set(s);
    const span = this.editorRef?.nativeElement
      .querySelector<HTMLElement>(`.quill-suggestion-mark[data-suggestion-id="${s.id}"]`);
    if (span) span.setAttribute('data-type', s.type === 'comment' ? 'comment' : 'replace');
  }

  /** Strips every review decoration (e.g. when the review is dismissed). */
  clearAllReviewDecorations(): void {
    this.reviewSuggestions.clear();
    this.hideReviewPopover();
    this.editorRef?.nativeElement
      .querySelectorAll<HTMLElement>('.quill-suggestion-mark')
      .forEach(span => this.unwrapElement(span));
  }

  /** Visually emphasizes a decoration in place, without scrolling (hover sync). */
  emphasizeDecoration(id: string): void {
    const el = this.editorRef?.nativeElement;
    if (!el) return;
    this.clearEmphasis();
    el.querySelector<HTMLElement>(`.quill-suggestion-mark[data-suggestion-id="${id}"]`)
      ?.classList.add('is-emphasized');
  }

  /** Emphasizes a decoration and scrolls it into view (sidebar card click). */
  scrollToDecoration(id: string): void {
    const el = this.editorRef?.nativeElement;
    if (!el) return;
    this.clearEmphasis();
    const span = el.querySelector<HTMLElement>(`.quill-suggestion-mark[data-suggestion-id="${id}"]`);
    if (span) {
      span.classList.add('is-emphasized');
      span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /** Reverts an accepted edit by swapping the replacement back to the original.
   *  Best-effort: returns false if the replacement text can't be located. */
  revertSuggestionEdit(s: ReviewDecoration): boolean {
    const el = this.editorRef?.nativeElement;
    const block = el?.children[s.blockIndex];
    if (!el || !block || !s.replacementText) return false;
    const range = this.locateRangeInBlock(block, s.replacementText);
    if (!range) return false;
    range.deleteContents();
    range.insertNode(document.createTextNode(s.originalText));
    block.normalize();
    this.commitCleanContent();
    return true;
  }

  clearEmphasis(): void {
    this.editorRef?.nativeElement
      .querySelectorAll('.quill-suggestion-mark.is-emphasized')
      .forEach(s => s.classList.remove('is-emphasized'));
  }

  hideReviewPopover(): void {
    this.reviewPopoverVisible.set(false);
    this.reviewPopoverData.set(null);
  }

  /** Emits the action from the inline popover; the host applies it. */
  emitReviewAction(action: 'accept' | 'reject'): void {
    const data = this.reviewPopoverData();
    if (!data) return;
    this.hideReviewPopover();
    this.reviewSuggestionAction.emit({ id: data.id, action });
  }

  /** Unwraps an element, splicing its children into its parent. */
  private unwrapElement(el: HTMLElement): void {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  }

  /** Recomputes the clean (decoration-free) content string and emits it so the
   *  accepted edit reaches autosave without leaking any review markup. */
  private commitCleanContent(): void {
    const el = this.editorRef?.nativeElement;
    if (!el) return;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll<HTMLElement>('.quill-suggestion-mark, mark.quill-review-highlight')
      .forEach(s => {
        const parent = s.parentNode!;
        while (s.firstChild) parent.insertBefore(s.firstChild, s);
        parent.removeChild(s);
      });
    clone.normalize();
    this.editorContent = clone.innerHTML;
    this.wordCount.set(this.countWords(clone.textContent ?? ''));
    this.scheduleEmit();
    this.scheduleMinimap();
  }

  /** Opens the inline accept/reject popover anchored to a decoration. */
  private showReviewPopover(span: HTMLElement, data: ReviewDecoration): void {
    const rect = span.getBoundingClientRect();
    const off = this.getFixedOffset();
    const GAP = 6;
    const POPUP_HEIGHT_EST = 160;
    const above = rect.bottom + GAP + POPUP_HEIGHT_EST > window.innerHeight;
    this.reviewPopoverAbove.set(above);
    this.reviewPopoverTop.set(above ? rect.top - GAP - off.y : rect.bottom + GAP - off.y);
    this.reviewPopoverLeft.set(Math.max(8, rect.left - off.x));
    this.reviewPopoverData.set(data);
    this.reviewPopoverVisible.set(true);
  }

  /** Reports decoration hover to the host (doc→sidebar sync). */
  private updateReviewHover(target: HTMLElement): void {
    const mark = target.closest?.('.quill-suggestion-mark') as HTMLElement | null;
    const id = mark?.getAttribute('data-suggestion-id') ?? null;
    if (id !== this.hoveredReviewId) {
      this.hoveredReviewId = id;
      this.reviewSuggestionHovered.emit(id);
    }
  }

  /** Returns the chapter as ordered top-level blocks for an AI review pass.
   *  `index` is the positional index within the editor's children and stays
   *  stable while the editor is locked, so a suggestion can be anchored back to
   *  exactly the block it came from. Empty blocks are skipped but their position
   *  is preserved in `index`. */
  extractReviewBlocks(): { index: number; text: string }[] {
    const el = this.editorRef?.nativeElement;
    if (!el) return [];
    const blocks: { index: number; text: string }[] = [];
    Array.from(el.children).forEach((child, index) => {
      const text = (child.textContent ?? '').replace(/ /g, ' ').trim();
      if (text) blocks.push({ index, text });
    });
    return blocks;
  }

  /** Applies a copy-edit replacement by locating `originalText` within the given
   *  block and swapping it for `replacementText`. Returns false (no-op) when the
   *  anchor can't be found — e.g. the text drifted. */
  applyReviewReplacement(blockIndex: number, originalText: string, replacementText: string): boolean {
    const el = this.editorRef?.nativeElement;
    const block = el?.children[blockIndex];
    if (!el || !block) return false;
    this.clearReviewHighlight();
    const range = this.locateRangeInBlock(block, originalText);
    if (!range) return false;
    range.deleteContents();
    range.insertNode(document.createTextNode(replacementText));
    block.normalize();
    this.editorContent = el.innerHTML;
    this.wordCount.set(this.countWords(el.textContent ?? ''));
    this.scheduleEmit();
    this.scheduleMinimap();
    return true;
  }

  /** Briefly highlights the text a suggestion targets and scrolls it into view. */
  highlightReviewAnchor(blockIndex: number, originalText: string): void {
    const el = this.editorRef?.nativeElement;
    const block = el?.children[blockIndex] as HTMLElement | undefined;
    if (!block) return;
    this.clearReviewHighlight();
    const range = this.locateRangeInBlock(block, originalText);
    if (range) {
      const mark = document.createElement('mark');
      mark.className = 'quill-review-highlight';
      try {
        range.surroundContents(mark);
        this.reviewHighlightEl = mark;
      } catch {
        // Range crosses element boundaries; skip the wrap but still scroll.
      }
    }
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** Removes the transient review highlight without dirtying saved content. */
  clearReviewHighlight(): void {
    const mark = this.reviewHighlightEl;
    this.reviewHighlightEl = null;
    if (!mark || !mark.isConnected) return;
    const parent = mark.parentNode!;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  /** Locates an exact substring within a block and returns a Range spanning it,
   *  walking text nodes so the match survives inline spans (entity refs, etc.).
   *  Treats &nbsp; as a regular space to mirror how block text is extracted. */
  private locateRangeInBlock(block: Element, target: string): Range | null {
    if (!target) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let concat = '';
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const t = node as Text;
      nodes.push(t);
      concat += t.textContent ?? '';
    }
    const start = concat.replace(/ /g, ' ').indexOf(target);
    if (start === -1) return null;
    const startPos = this.flatOffsetToNode(nodes, start);
    const endPos = this.flatOffsetToNode(nodes, start + target.length);
    if (!startPos || !endPos) return null;
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    return range;
  }

  /** Maps a flat character offset across concatenated text nodes to a concrete
   *  (node, offset) position. */
  private flatOffsetToNode(nodes: Text[], offset: number): { node: Text; offset: number } | null {
    let remaining = offset;
    for (const node of nodes) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) return { node, offset: remaining };
      remaining -= len;
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last, offset: last.textContent?.length ?? 0 } : null;
  }

  // ── Search (find-in-page) ────────────────────────────────────────────────

  private searchMarks: HTMLElement[] = [];
  private searchActive = false;

  /** Highlight all case-insensitive matches of query; returns match count. */
  highlightSearchMatches(query: string): number {
    const editor = this.editorRef?.nativeElement;
    if (!editor) return 0;
    this.clearSearchHighlights();
    if (!query.trim()) return 0;

    const lowerQuery = query.toLowerCase();
    const queryLen = query.length;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) textNodes.push(node as Text);

    const marks: HTMLElement[] = [];
    for (const textNode of textNodes) {
      const text = textNode.textContent ?? '';
      const lower = text.toLowerCase();
      let idx = lower.indexOf(lowerQuery);
      if (idx === -1) continue;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      while (idx !== -1) {
        if (idx > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
        const mark = document.createElement('mark');
        mark.setAttribute('data-search-match', '');
        mark.textContent = text.slice(idx, idx + queryLen);
        frag.appendChild(mark);
        marks.push(mark);
        lastIdx = idx + queryLen;
        idx = lower.indexOf(lowerQuery, lastIdx);
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      textNode.parentNode!.replaceChild(frag, textNode);
    }

    this.searchMarks = marks;
    this.searchActive = marks.length > 0;
    return marks.length;
  }

  /** Remove all search highlights and restore clean DOM state. */
  clearSearchHighlights(): void {
    const editor = this.editorRef?.nativeElement;
    if (!editor) return;
    editor.querySelectorAll('mark[data-search-match]').forEach(mark => {
      const parent = mark.parentNode!;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    });
    editor.normalize();
    this.editorContent = editor.innerHTML;
    this.searchMarks = [];
    this.searchActive = false;
  }

  /** Activate the nth match (0-based) and scroll it into view. */
  scrollToSearchMatch(index: number): void {
    this.searchMarks.forEach((m, i) => m.classList.toggle('search-match-active', i === index));
    const active = this.searchMarks[index];
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** Returns the bounding rect of the current selection, or null. */
  getSelectionRect(): DOMRect | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    return sel.getRangeAt(0).getBoundingClientRect();
  }

  // ── Content input handler ────────────────────────────────────────────────

  onContentInput(event: Event): void {
    const el = event.target as HTMLDivElement;
    if (this.searchActive) {
      el.querySelectorAll('mark[data-search-match]').forEach(m => {
        const p = m.parentNode!; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m);
      });
      el.normalize();
      this.searchMarks = [];
      this.searchActive = false;
    }
    this.editorContent = el.innerHTML;
    this.wordCount.set(this.countWords(el.textContent ?? ''));

    // If a sentence-ending ejection was set on a previous input, check whether
    // Chrome snapped the newly typed text back inside the AI span. If so,
    // extract the overflow and move it out.
    const ejectedSpan = this.lastEjectedSpan;
    if (ejectedSpan?.isConnected) {
      const currentLen = ejectedSpan.textContent?.length ?? 0;
      if (currentLen > this.lastEjectedSpanTextLength) {
        this.extractOverflowFromAiSpan(ejectedSpan, this.lastEjectedSpanTextLength);
        this.editorContent = el.innerHTML;
      } else {
        // Span didn't grow — if cursor has moved away, clear the guard.
        const selClear = window.getSelection();
        if (selClear && selClear.rangeCount > 0) {
          const nc = selClear.getRangeAt(0).startContainer;
          const inSpan = (nc.nodeType === Node.ELEMENT_NODE ? nc as Element : (nc as Text).parentElement)
            ?.closest('[data-ai-generated]');
          if (inSpan !== ejectedSpan) this.lastEjectedSpan = null;
        }
      }
    }

    // Mark AI-generated spans as modified when the user edits text inside them
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const node = sel.getRangeAt(0).startContainer;
      const aiSpan = (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)
        ?.closest<HTMLElement>('[data-ai-generated="true"]');
      if (aiSpan) {
        aiSpan.setAttribute('data-ai-generated', 'modified');
        this.editorContent = el.innerHTML;
      }
    }

    // Detect sentence-ending punctuation followed by space typed inside an AI span.
    // Record the current span length as the eject-guard threshold so that on
    // the *next* input event we can extract any overflow Chrome snapped back in.
    const inputData = (event as InputEvent).data;
    if (inputData === ' ') {
      const selSp = window.getSelection();
      if (selSp && selSp.rangeCount > 0 && selSp.isCollapsed) {
        const rSp = selSp.getRangeAt(0);
        if (rSp.startContainer.nodeType === Node.TEXT_NODE) {
          const textSp = rSp.startContainer as Text;
          // At this point the space has already been inserted; offset - 2 is the char before it.
          const charBefore = (textSp.textContent ?? '')[rSp.startOffset - 2] ?? '';
          if (/[.!?]/.test(charBefore)) {
            const aiSpSp = textSp.parentElement?.closest<HTMLElement>('[data-ai-generated]');
            if (aiSpSp) {
              this.lastEjectedSpan = aiSpSp;
              this.lastEjectedSpanTextLength = aiSpSp.textContent?.length ?? 0;
            }
          }
        }
      }
    }

    // Strip trailing \u00A0 after entity-reference when punctuation typed
    if (inputData && /^[.,!?;:)'""\u2019\u201d]$/.test(inputData)) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const { startContainer, startOffset } = sel.getRangeAt(0);
        if (startContainer.nodeType === Node.TEXT_NODE) {
          const textNode = startContainer as Text;
          const text = textNode.textContent ?? '';
          const punctPos = startOffset - 1;
          if (punctPos >= 1 && text[punctPos - 1] === '\u00A0') {
            const prevSib = textNode.previousSibling as HTMLElement | null;
            if (prevSib?.classList?.contains('entity-reference')) {
              textNode.textContent = text.slice(0, punctPos - 1) + text.slice(punctPos);
              const r = document.createRange();
              r.setStart(textNode, punctPos);
              r.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r);
              this.editorContent = el.innerHTML;
            }
          } else {
            const prev = textNode.previousSibling;
            if (
              prev?.nodeType === Node.TEXT_NODE &&
              (prev as Text).textContent?.endsWith('\u00A0') &&
              prev.previousSibling?.nodeType === Node.ELEMENT_NODE &&
              (prev.previousSibling as HTMLElement).classList.contains('entity-reference')
            ) {
              const prevText = prev as Text;
              if (prevText.textContent === '\u00A0') prevText.remove();
              else prevText.textContent = prevText.textContent!.slice(0, -1);
              this.editorContent = el.innerHTML;
            }
          }
        }
      }
    }

    this.checkAutocomplete();
    this.scheduleMinimap();
    this.scheduleEmit();
    this.scheduleGrammarCheck();
  }

  // ── Paste handler ──────────────────────────────────────────────────────

  onEditorPaste(event: ClipboardEvent): void {
    event.preventDefault();
    const clipboard = event.clipboardData;
    if (!clipboard) return;

    const html = clipboard.getData('text/html');
    const text = clipboard.getData('text/plain');

    if (html) {
      this.insertPastedHtml(this.cleanPastedHtml(html));
    } else {
      // Plain text: single line → inline text; multiple lines → one <p> per line.
      const lines = text.split('\n');
      if (lines.length === 1) {
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        document.execCommand('insertHTML', false, escaped);
      } else {
        const blocksHtml = lines
          .map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>'}</p>`)
          .join('');
        this.insertPastedHtml(blocksHtml);
      }
    }

    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
    this.scheduleMinimap();
  }

  /**
   * Inserts cleaned HTML at the current cursor position without creating
   * spurious empty paragraphs. For single-block content the inner HTML is
   * inserted inline. For multi-block content the current paragraph is split
   * at the cursor and the blocks are merged correctly.
   */
  private insertPastedHtml(html: string): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    range.deleteContents();

    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    // Drop whitespace-only text nodes that would produce spurious line breaks.
    const pastedNodes = Array.from(tmp.childNodes).filter(
      n => !(n.nodeType === Node.TEXT_NODE && !(n as Text).data.trim()),
    );

    if (pastedNodes.length === 0) return;

    const BLOCK_TAGS = new Set(['P', 'DIV', 'BLOCKQUOTE', 'PRE']);
    const allBlock = pastedNodes.every(
      n => n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((n as Element).tagName),
    );

    // ── Single paragraph or inline content ──────────────────────────────
    // Insert the inner HTML directly so insertHTML never needs to split a block.
    if (!allBlock || pastedNodes.length === 1) {
      const inlineHtml = allBlock
        ? (pastedNodes[0] as HTMLElement).innerHTML
        : pastedNodes.map(n => (n as HTMLElement).outerHTML ?? (n as Text).data).join('');
      document.execCommand('insertHTML', false, inlineHtml);
      return;
    }

    // ── Multiple block paragraphs ────────────────────────────────────────
    // Split the current paragraph at the cursor and stitch the pasted blocks
    // in between so no extra empty paragraphs appear.
    const editor = this.editorRef?.nativeElement as HTMLElement | undefined;
    if (!editor) { document.execCommand('insertHTML', false, html); return; }

    // Find the direct-child block of the editor that contains the cursor.
    let curBlock: Node | null = range.startContainer;
    while (curBlock && curBlock.parentNode !== editor) curBlock = curBlock.parentNode;
    if (!curBlock) { document.execCommand('insertHTML', false, html); return; }

    // Extract everything after the cursor from curBlock (removes it from DOM).
    const afterRange = document.createRange();
    afterRange.setStart(range.startContainer, range.startOffset);
    afterRange.setEnd(curBlock, curBlock.childNodes.length);
    const afterFrag = afterRange.extractContents();

    // Merge the first pasted block's children into curBlock (now ends at cursor).
    const firstBlock = pastedNodes[0] as HTMLElement;
    while (firstBlock.firstChild) curBlock.appendChild(firstBlock.firstChild);

    // Insert any middle blocks.
    let ref: Node = curBlock;
    for (let i = 1; i < pastedNodes.length - 1; i++) {
      const mid = pastedNodes[i] as HTMLElement;
      if (!mid.innerHTML.trim()) mid.innerHTML = '<br>';
      editor.insertBefore(mid, ref.nextSibling);
      ref = mid;
    }

    // Build trailing block: last pasted block content + what was after cursor.
    const trailingP = document.createElement('p');
    const lastBlock = pastedNodes[pastedNodes.length - 1] as HTMLElement;
    let lastPastedChild: Node | null = null;
    while (lastBlock.firstChild) {
      lastPastedChild = lastBlock.firstChild;
      trailingP.appendChild(lastPastedChild);
    }
    trailingP.appendChild(afterFrag);
    if (!trailingP.textContent && !trailingP.querySelector('br, img')) {
      trailingP.appendChild(document.createElement('br'));
    }
    editor.insertBefore(trailingP, ref.nextSibling);

    // Position cursor at the end of the last pasted content (before the after-text).
    const newRange = document.createRange();
    if (lastPastedChild) {
      if (lastPastedChild.nodeType === Node.TEXT_NODE) {
        newRange.setStart(lastPastedChild, (lastPastedChild as Text).length);
      } else {
        newRange.setStartAfter(lastPastedChild);
      }
    } else {
      newRange.setStart(trailingP, 0);
    }
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }

  private cleanPastedHtml(html: string): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.body;

    // Inline formatting tags to unwrap (replace with their children)
    const UNWRAP_TAGS = new Set([
      'FONT', 'SPAN', 'U', 'S', 'STRIKE', 'SUB', 'SUP',
      'B', 'STRONG', 'I', 'EM', 'INS', 'DEL', 'MARK',
    ]);

    const processNode = (node: Node): void => {
      // Remove HTML comment nodes (e.g. <!--StartFragment-->)
      if (node.nodeType === Node.COMMENT_NODE) {
        node.parentNode?.removeChild(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;

      // Strip all presentation attributes
      el.removeAttribute('style');
      el.removeAttribute('class');
      el.removeAttribute('id');
      el.removeAttribute('color');
      el.removeAttribute('face');
      el.removeAttribute('size');
      el.removeAttribute('bgcolor');
      el.removeAttribute('align');
      el.removeAttribute('valign');
      el.removeAttribute('width');
      el.removeAttribute('height');
      el.removeAttribute('dir');

      // Process children depth-first so unwrapping works bottom-up
      Array.from(el.childNodes).forEach(child => processNode(child));

      const tag = el.tagName;

      if (UNWRAP_TAGS.has(tag)) {
        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
          parent.removeChild(el);
        }
      } else if (tag === 'H1' || tag === 'H2' || tag === 'H3' ||
                 tag === 'H4' || tag === 'H5' || tag === 'H6') {
        // Convert heading to a plain text node wrapped in a <br> — headings may
        // contain block children (p, div) that produce nested-p invalid HTML.
        // Instead extract just the text content and insert as a text node.
        const textContent = el.textContent ?? '';
        const textNode = doc.createTextNode(textContent);
        el.parentNode?.replaceChild(textNode, el);
      }
    };

    Array.from(body.childNodes).forEach(node => processNode(node));

    // Remove whitespace-only text nodes left at the body level (e.g. newlines
    // between <p> tags in the source HTML). They would produce spurious <p>
    // elements when insertHTML encounters them.
    Array.from(body.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE && !(node as Text).data.trim()) {
        body.removeChild(node);
      }
    });

    return body.innerHTML;
  }

  // ── Keyboard handler ─────────────────────────────────────────────────────

  onEditorKeyDown(event: KeyboardEvent): void {
    // Grammar popover
    if (this.grammarPopoverVisible()) {
      if (event.key === 'Escape') {
        event.preventDefault(); this.dismissGrammarPopover(); return;
      }
      const isNavKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key);
      const isTypingKey = !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1;
      if (isNavKey || isTypingKey) {
        this.dismissGrammarPopover();
      }
    }

    // Ctrl+. context menu
    if (this.ctxMenuVisible()) {
      if (event.key === 'Escape') { event.preventDefault(); this.closeCtxMenu(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); this.ctxMenuFocusedIndex.update(i => (i + 1) % this.ctxMenuItems().length); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); this.ctxMenuFocusedIndex.update(i => (i - 1 + this.ctxMenuItems().length) % this.ctxMenuItems().length); return; }
      if (event.key === 'Enter') { event.preventDefault(); this.executeCtxMenuItem(this.ctxMenuItems()[this.ctxMenuFocusedIndex()]); return; }
      this.closeCtxMenu();
    }

    // Tab: insert character (when autocomplete not active)
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && this.autocompleteItems().length === 0) {
      event.preventDefault();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const tab = document.createTextNode('\t');
        range.insertNode(tab);
        range.setStartAfter(tab);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
      }
      return;
    }

    if ((event.ctrlKey && event.key === '.') || (event.altKey && event.key === '.')) { event.preventDefault(); this.openCtxMenu(); return; }

    // Eject cursor from entity-reference span
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const { startContainer } = sel.getRangeAt(0);
        const node = startContainer.nodeType === Node.TEXT_NODE ? startContainer.parentElement : startContainer as HTMLElement;
        if (node?.classList.contains('entity-reference')) {
          event.preventDefault();
          const textNode = document.createTextNode(event.key);
          node.after(textNode);
          const nr = document.createRange();
          nr.setStartAfter(textNode);
          nr.collapse(true);
          sel.removeAllRanges();
          sel.addRange(nr);
          if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
          this.checkAutocomplete();
          return;
        }
      }
    }

    // Delete key clears image selection
    if ((event.key === 'Backspace' || event.key === 'Delete') && this.selectedImage()) {
      this.clearImageSelection();
    }

    // Backspace removes entire entity-reference span
    if (event.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        const { startContainer, startOffset } = range;
        let spanToDelete: HTMLElement | null = null;
        const node = startContainer.nodeType === Node.TEXT_NODE ? startContainer.parentElement : startContainer as HTMLElement;
        if (node?.classList.contains('entity-reference')) spanToDelete = node;
        if (!spanToDelete && startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
          const prev = startContainer.previousSibling;
          if (prev instanceof HTMLElement && prev.classList.contains('entity-reference')) spanToDelete = prev;
        }
        if (!spanToDelete && startContainer.nodeType === Node.ELEMENT_NODE && startOffset > 0) {
          const prevNode = (startContainer as Element).childNodes[startOffset - 1];
          if (prevNode instanceof HTMLElement && prevNode.classList.contains('entity-reference')) spanToDelete = prevNode;
        }
        if (spanToDelete) {
          event.preventDefault();
          const nr = document.createRange();
          nr.setStartBefore(spanToDelete);
          nr.collapse(true);
          spanToDelete.remove();
          sel.removeAllRanges();
          sel.addRange(nr);
          if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
          return;
        }
      }
    }

    // Enter: eject cursor from ai-generated span so the new block starts outside it.
    if (event.key === 'Enter' && !event.shiftKey && this.autocompleteItems().length === 0) {
      if (this.ejectFromAiSpan() && this.editorRef) {
        this.lastEjectedSpan = null; // new block element always lands outside the span
        this.editorContent = this.editorRef.nativeElement.innerHTML;
        // Chrome clones the inline formatting context (including the ai-generated span
        // and any <font color>) into the new block asynchronously after Enter.
        // Run cleanup once the browser has finished building the new paragraph.
        setTimeout(() => {
          if (!this.editorRef) return;
          const editor = this.editorRef.nativeElement;
          // Find the block that now contains the cursor — that is the new paragraph.
          const sel = window.getSelection();
          const cursorNode = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null;
          const newBlock = cursorNode
            ? (cursorNode.nodeType === Node.TEXT_NODE
                ? (cursorNode as Text).parentElement
                : cursorNode as HTMLElement)?.closest<HTMLElement>(
                    'div, p, li, blockquote, h1, h2, h3, h4, h5, h6')
            : null;
          // Unwrap every data-ai-generated span inside the new block.
          // These were copied in by the browser, not typed by the user.
          const scope: Element = newBlock ?? editor;
          scope.querySelectorAll<HTMLElement>('[data-ai-generated]').forEach(span => {
            const parent = span.parentNode!;
            while (span.firstChild) parent.insertBefore(span.firstChild, span);
            parent.removeChild(span);
          });
          // Also strip any <font color> Chrome injected.
          scope.querySelectorAll('font').forEach((font: HTMLElement) => {
            const parent = font.parentNode!;
            while (font.firstChild) parent.insertBefore(font.firstChild, font);
            parent.removeChild(font);
          });
          this.editorContent = editor.innerHTML;
        }, 0);
      }
    }

    // Autocomplete navigation
    const items = this.autocompleteItems();
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); this.autocompleteIndex.set(Math.min(this.autocompleteIndex() + 1, items.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); this.autocompleteIndex.set(Math.max(this.autocompleteIndex() - 1, 0)); }
    else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); const item = items[this.autocompleteIndex()]; this.selectAutocomplete(item.entity, item.text); }
    else if (event.key === 'Escape') { this.autocompleteItems.set([]); this.currentWordRange = null; }
  }

  selectAutocomplete(entity: Entity, text: string): void {
    if (!this.currentWordRange) return;
    const range = this.currentWordRange;
    this.currentWordRange = null;
    this.autocompleteItems.set([]);
    range.deleteContents();
    const span = document.createElement('span');
    span.setAttribute('data-id', entity.id);
    span.setAttribute('data-reference-type', this.getReferenceType(entity, text));
    span.className = 'entity-reference';
    span.textContent = text;
    range.insertNode(span);
    const space = document.createTextNode('\u00A0');
    span.after(space);
    const nr = document.createRange();
    nr.setStartAfter(space);
    nr.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(nr); }
    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
  }

  // ── Mouse / touch handlers ───────────────────────────────────────────────

  onEditorClick(event: MouseEvent): void {
    this.lastEjectedSpan = null; // user repositioned cursor manually
    const target = event.target as HTMLElement;

    // Quill Editor decoration — open its inline accept/reject popover.
    const reviewMark = target.closest?.('.quill-suggestion-mark') as HTMLElement | null;
    if (reviewMark) {
      const id = reviewMark.getAttribute('data-suggestion-id');
      const data = id ? this.reviewSuggestions.get(id) : null;
      if (data) {
        this.showReviewPopover(reviewMark, data);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    // Photo reference icon — show popup on tap/click (touch support)
    const photoRefEl = target.closest?.('.photo-ref-icon') as HTMLElement | null;
    if (photoRefEl) {
      const rect = photoRefEl.getBoundingClientRect();
      const off = this.getFixedOffset();
      const photoUrl = photoRefEl.getAttribute('data-photo-url') ?? '';
      this.photoRefHoveredEl = photoRefEl;
      this.photoRefPopupPhotoUrl.set(photoUrl);
      const POPUP_HEIGHT_EST = 380;
      const GAP = 6;
      const above = rect.bottom + GAP + POPUP_HEIGHT_EST > window.innerHeight;
      this.photoRefPopupTop.set(above ? rect.top - GAP - off.y : rect.bottom + GAP - off.y);
      this.photoRefPopupLeft.set(Math.max(8, rect.left - off.x));
      this.photoRefPopupAbove.set(above);
      this.photoRefPopupVisible.set(true);
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const grammarMark = target.closest('mark.grammar-error') as HTMLElement | null;
    if (grammarMark) { this.showGrammarPopover(event, grammarMark); return; }
    if (target.tagName === 'IMG') {
      const img = target as HTMLImageElement;
      this.editorRef?.nativeElement.querySelectorAll('img.image-selected').forEach(el => el.classList.remove('image-selected'));
      img.classList.add('image-selected');
      this.selectedImage.set(img);
      this.positionImageToolbar(img);
      this.showFormattingToolbarForImage(img);
    } else {
      this.clearImageSelection();
    }
  }

  onEditorMouseUp(): void {
    setTimeout(() => this.updateFormattingToolbar());
  }

  onEditorKeyUp(event: KeyboardEvent): void {
    // Update toolbar for any key that can affect the selection — both expanding keys
    // (Shift+arrows, Ctrl+A) and collapsing keys (bare arrow keys, Home/End, etc.).
    const isNavigationKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key);
    const isSelectionKey = event.shiftKey || event.key === 'Shift'
      || (event.key === 'a' && (event.ctrlKey || event.metaKey));
    if (isSelectionKey || isNavigationKey) {
      setTimeout(() => this.updateFormattingToolbar());
    }
  }

  onEditorMouseMove(event: MouseEvent): void {
    const target = event.target as HTMLElement;

    // Quill Editor: report which decoration (if any) is under the cursor.
    this.updateReviewHover(target);

    // Photo reference icon hover
    const photoRefEl = target.closest?.('.photo-ref-icon') as HTMLElement | null;
    if (photoRefEl) {
      if (this.photoRefPopupHideTimer) { clearTimeout(this.photoRefPopupHideTimer); this.photoRefPopupHideTimer = null; }
      if (this.photoRefHoveredEl !== photoRefEl) {
        this.photoRefHoveredEl = photoRefEl;
        if (this.photoRefPopupShowTimer) clearTimeout(this.photoRefPopupShowTimer);
        const rect = photoRefEl.getBoundingClientRect();
        this.photoRefPopupShowTimer = setTimeout(() => {
          const off = this.getFixedOffset();
          const photoUrl = photoRefEl.getAttribute('data-photo-url') ?? '';
          this.photoRefPopupPhotoUrl.set(photoUrl);
          const POPUP_HEIGHT_EST = 380;
          const GAP = 6;
          const above = rect.bottom + GAP + POPUP_HEIGHT_EST > window.innerHeight;
          this.photoRefPopupTop.set(above ? rect.top - GAP - off.y : rect.bottom + GAP - off.y);
          this.photoRefPopupLeft.set(Math.max(8, rect.left - off.x));
          this.photoRefPopupAbove.set(above);
          this.photoRefPopupVisible.set(true);
          this.photoRefPopupShowTimer = null;
        }, 200);
      }
      if (this.hoveredEntity() !== null || this.popupShowTimer) this.scheduleHidePopup();
      return;
    }

    // Clear photo ref popup when moving away — don't null photoRefHoveredEl here;
    // let scheduleHidePhotoRefPopup() do it after the delay so the popup buttons
    // remain functional if onPhotoRefPopupMouseEnter cancels the timer.
    if (this.photoRefPopupVisible() || this.photoRefPopupShowTimer) {
      if (this.photoRefPopupShowTimer) { clearTimeout(this.photoRefPopupShowTimer); this.photoRefPopupShowTimer = null; }
      this.scheduleHidePhotoRefPopup();
    }

    if (target.classList.contains('entity-reference')) {
      const entityId = target.getAttribute('data-id');
      if (this.popupHideTimer) { clearTimeout(this.popupHideTimer); this.popupHideTimer = null; }
      if (entityId && this.hoveredEntity()?.id !== entityId) {
        const entity = this.entities().find(e => e.id === entityId);
        if (entity) {
          const rect = target.getBoundingClientRect();
          if (this.popupShowTimer) clearTimeout(this.popupShowTimer);
          this.popupShowTimer = setTimeout(() => {
            const off = this.getFixedOffset();
            this.popupTop.set(rect.bottom + 6 - off.y);
            this.popupLeft.set(rect.left - off.x);
            this.hoveredEntity.set(entity);
            this.popupShowTimer = null;
          }, 200);
        }
      }
    } else if (this.hoveredEntity() !== null || this.popupShowTimer) {
      if (this.popupShowTimer) { clearTimeout(this.popupShowTimer); this.popupShowTimer = null; }
      this.scheduleHidePopup();
    }
  }

  onEditorMouseLeave(): void {
    this.scheduleHidePopup();
    if (this.photoRefPopupShowTimer) { clearTimeout(this.photoRefPopupShowTimer); this.photoRefPopupShowTimer = null; }
    this.scheduleHidePhotoRefPopup();
    if (this.hoveredReviewId !== null) {
      this.hoveredReviewId = null;
      this.reviewSuggestionHovered.emit(null);
    }
  }
  onPopupMouseEnter(): void { if (this.popupHideTimer) { clearTimeout(this.popupHideTimer); this.popupHideTimer = null; } }
  onPopupMouseLeave(): void { this.scheduleHidePopup(); }

  private scheduleHidePopup(): void {
    if (this.popupHideTimer) clearTimeout(this.popupHideTimer);
    this.popupHideTimer = setTimeout(() => { this.hoveredEntity.set(null); this.popupHideTimer = null; }, 150);
  }

  onEditorScroll(): void {
    const img = this.selectedImage();
    if (img) this.positionImageToolbar(img);
    this.scheduleMinimap();
  }

  onEditorTouchStart(event: TouchEvent): void {
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      event.preventDefault();
      this.requestAiAssist();
    }, 600);
  }

  onEditorTouchEnd(): void { if (this.longPressTimer !== null) { clearTimeout(this.longPressTimer); this.longPressTimer = null; } }
  onEditorTouchMove(): void { if (this.longPressTimer !== null) { clearTimeout(this.longPressTimer); this.longPressTimer = null; } }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.rte-autocomplete-dropdown')) { this.autocompleteItems.set([]); this.currentWordRange = null; }
    if (!target.closest('.rte-formatting-toolbar')) { this.formattingToolbarVisible.set(false); }
    if (this.grammarPopoverVisible() && !target.closest('.rte-grammar-popover')) this.dismissGrammarPopover();
    if (this.ctxMenuVisible() && !target.closest('.rte-ctx-menu')) this.closeCtxMenu();
    if (this.selectedImage() && target.tagName !== 'IMG' && !target.closest('.rte-image-resize-overlay')) this.clearImageSelection();
    if (this.photoPickerVisible() && !target.closest('.rte-photo-picker') && !target.closest('.rte-formatting-toolbar')) this.closePhotoPicker();
    if (this.photoRefPopupVisible() && !target.closest('.rte-photo-ref-popup') && !target.closest('.photo-ref-icon')) this.hidePhotoRefPopup();
  }

  @HostListener('document:mouseup')
  onDocumentMouseUp(): void {
    this.minimapDragging = false;
  }

  // ── Formatting toolbar ───────────────────────────────────────────────────

  private updateFormattingToolbar(): void {
    if (this.formattingToolbarShownForImage) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.toString().trim() === '') {
      this.formattingToolbarVisible.set(false);
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width) { this.formattingToolbarVisible.set(false); return; }
    const toolbarWidthCenter = 330;
    const toolbarWidthMax = 400;
    const off = this.getFixedOffset();
    const editorRect = this.editorRef?.nativeElement?.getBoundingClientRect();
    const containerRight = editorRect ? (editorRect.right - off.x) : window.innerWidth;
    const left = (rect.left - off.x) + rect.width / 2 - toolbarWidthCenter / 2;
    this.formattingToolbarTop.set(rect.top - off.y - 44);
    this.formattingToolbarLeft.set(Math.max(8, Math.min(left, containerRight - toolbarWidthMax - 8)));
    this.formattingState.set({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      align: document.queryCommandState('justifyCenter') ? 'center'
           : document.queryCommandState('justifyRight')  ? 'right'
           : document.queryCommandState('justifyFull')   ? 'justify' : 'left',
    });
    this.formattingToolbarVisible.set(true);
  }

  applyFormat(command: 'bold' | 'italic' | 'underline' | 'insertUnorderedList' | 'justifyLeft' | 'justifyCenter' | 'justifyRight' | 'justifyFull'): void {
    const img = this.selectedImage();
    if (img && command.startsWith('justify')) {
      const alignMap: Record<string, 'left' | 'center' | 'right' | 'justify'> = { justifyLeft: 'left', justifyCenter: 'center', justifyRight: 'right', justifyFull: 'justify' };
      this.applyAlignToImage(img, alignMap[command]);
      return;
    }
    document.execCommand(command, false);
    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
    this.formattingState.set({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      align: document.queryCommandState('justifyCenter') ? 'center' : document.queryCommandState('justifyRight') ? 'right' : document.queryCommandState('justifyFull') ? 'justify' : 'left',
    });
  }

  // ── Entity tag panel ─────────────────────────────────────────────────────

  openEntityTagPanel(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    this.entityTagSavedRange = sel.getRangeAt(0).cloneRange();
    this.entityTagSearchQuery.set('');
    this.entityTagFocusIndex.set(0);
    const PANEL_HEIGHT_EST = 270;
    const GAP = 6;
    const toolbarTop = this.formattingToolbarTop();
    const off = this.getFixedOffset();
    const belowTop = toolbarTop + 44 + GAP;
    const panelTop = belowTop + PANEL_HEIGHT_EST > window.innerHeight - off.y
      ? Math.max(GAP, toolbarTop - PANEL_HEIGHT_EST - GAP)
      : belowTop;
    this.entityTagPanelTop.set(panelTop);
    this.entityTagPanelLeft.set(this.formattingToolbarLeft());
    this.entityTagPanelVisible.set(true);
    setTimeout(() => {
      const input = this.entityTagInputRef?.nativeElement;
      input?.focus();
    });
  }

  onEntityTagSearchKeyDown(event: KeyboardEvent): void {
    const items = this.entityTagFilteredEntities();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.entityTagFocusIndex.set(Math.min(this.entityTagFocusIndex() + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.entityTagFocusIndex.set(Math.max(this.entityTagFocusIndex() - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entity = items[this.entityTagFocusIndex()];
      if (entity) this.applyEntityTagFromPanel(entity);
    } else if (event.key === 'Escape') {
      this.closeEntityTagPanel();
    }
  }

  applyEntityTagFromPanel(entity: Entity): void {
    const range = this.entityTagSavedRange;
    if (!range) { this.closeEntityTagPanel(); return; }
    const selectedText = range.toString();
    if (!selectedText.trim()) { this.closeEntityTagPanel(); return; }
    this.closeEntityTagPanel();
    const span = document.createElement('span');
    span.setAttribute('data-id', entity.id);
    span.setAttribute('data-reference-type', this.getReferenceType(entity, selectedText));
    span.className = 'entity-reference';
    span.textContent = selectedText;
    range.deleteContents();
    range.insertNode(span);
    const nr = document.createRange();
    nr.setStartAfter(span);
    nr.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(nr); }
    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
  }

  onEntityTagInputBlur(event: FocusEvent): void {
    const related = event.relatedTarget as HTMLElement | null;
    if (related?.closest('.rte-entity-tag-panel')) return;
    this.closeEntityTagPanel();
  }

  closeEntityTagPanel(): void {
    this.entityTagPanelVisible.set(false);
    this.entityTagSavedRange = null;
  }

  // ── Photo picker ──────────────────────────────────────────────────────────

  openPhotoPicker(): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    this.photoPickerSavedRange = sel.getRangeAt(0).cloneRange();
    this.photoPickerChangingEl = null;
    this.photoPickerEntityQuery.set('');
    this.photoPickerEntityFocusIndex.set(0);
    this.photoPickerSelectedEntity.set(null);
    this.photoPickerStep.set('entity');
    this.photoPickerUploading.set(false);
    this.positionPhotoPicker();
    this.photoPickerVisible.set(true);
    setTimeout(() => this.photoPickerEntityInputRef?.nativeElement.focus());
  }

  private positionPhotoPicker(): void {
    const PANEL_HEIGHT_EST = 300;
    const PANEL_WIDTH = 280;
    const GAP = 6;
    const toolbarTop = this.formattingToolbarTop();
    const toolbarLeft = this.formattingToolbarLeft();
    const off = this.getFixedOffset();
    const belowTop = toolbarTop + 44 + GAP;
    const above = belowTop + PANEL_HEIGHT_EST > window.innerHeight - off.y;
    const panelTop = above ? Math.max(GAP, toolbarTop - PANEL_HEIGHT_EST - GAP) : belowTop;
    const panelLeft = Math.max(GAP, Math.min(toolbarLeft, window.innerWidth - PANEL_WIDTH - GAP));
    this.photoPickerTop.set(panelTop);
    this.photoPickerLeft.set(panelLeft);
    this.photoPickerAbove.set(above);
  }

  closePhotoPicker(): void {
    this.photoPickerVisible.set(false);
    this.photoPickerChangingEl = null;
    this.photoPickerSavedRange = null;
  }

  selectPhotoPickerEntity(entity: Entity): void {
    this.photoPickerSelectedEntity.set(entity);
    this.photoPickerStep.set('source');
  }

  openPhotoGallery(): void {
    this.photoPickerStep.set('gallery');
  }

  openPhotoUpload(): void {
    this.photoPickerStep.set('upload');
  }

  selectPhotoFromGallery(photo: { url: string; thumbnailUrl: string }): void {
    const entity = this.photoPickerSelectedEntity();
    if (!entity) return;
    const thumbUrl = this.proxyUrl(photo.thumbnailUrl) ?? photo.thumbnailUrl;
    const fullUrl = this.proxyUrl(photo.url) ?? photo.url;
    this.insertPhotoReference(fullUrl, thumbUrl, entity.id);
    this.closePhotoPicker();
  }

  onPhotoFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const entity = this.photoPickerSelectedEntity();
    if (!entity) return;
    this.photoPickerUploading.set(true);
    this.entityService.uploadThumbnail(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        this.entityService.addPhoto(entity.id, url, thumbnailUrl).subscribe({
          next: (updatedEntity) => {
            this.entities.update(list => list.map(e => e.id === entity.id ? updatedEntity : e));
            const thumbUrl = this.proxyUrl(thumbnailUrl) ?? thumbnailUrl;
            const fullUrl = this.proxyUrl(url) ?? url;
            this.insertPhotoReference(fullUrl, thumbUrl, entity.id);
            this.photoPickerUploading.set(false);
            this.closePhotoPicker();
          },
          error: () => { this.photoPickerUploading.set(false); },
        });
      },
      error: () => { this.photoPickerUploading.set(false); },
    });
    input.value = '';
  }

  private insertPhotoReference(photoUrl: string, thumbUrl: string, entityId: string): void {
    const editorEl = this.editorRef?.nativeElement;
    if (!editorEl) return;
    const range = this.photoPickerSavedRange;
    if (!range || !editorEl.contains(range.commonAncestorContainer)) return;

    if (this.photoPickerChangingEl) {
      const el = this.photoPickerChangingEl;
      el.setAttribute('data-photo-url', photoUrl);
      el.setAttribute('data-photo-thumb', thumbUrl);
      el.setAttribute('data-entity-id', entityId);
      const img = el.querySelector('img');
      if (img) img.src = thumbUrl;
    } else {
      range.collapse(false);
      const span = document.createElement('span');
      span.className = 'photo-ref-icon';
      span.setAttribute('contenteditable', 'false');
      span.setAttribute('data-photo-url', photoUrl);
      span.setAttribute('data-photo-thumb', thumbUrl);
      span.setAttribute('data-entity-id', entityId);
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      span.appendChild(img);
      range.insertNode(span);
      const nr = document.createRange();
      nr.setStartAfter(span);
      nr.collapse(true);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(nr); }
    }
    this.editorContent = editorEl.innerHTML;
    this.scheduleEmit();
  }

  onPhotoPickerEntityKeyDown(event: KeyboardEvent): void {
    const filtered = this.photoPickerFilteredEntities();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.photoPickerEntityFocusIndex.set(Math.min(this.photoPickerEntityFocusIndex() + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.photoPickerEntityFocusIndex.set(Math.max(this.photoPickerEntityFocusIndex() - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entity = filtered[this.photoPickerEntityFocusIndex()];
      if (entity) this.selectPhotoPickerEntity(entity);
    } else if (event.key === 'Escape') {
      this.closePhotoPicker();
    }
  }

  // ── Photo reference hover popup ───────────────────────────────────────────

  private scheduleHidePhotoRefPopup(): void {
    if (this.photoRefPopupHideTimer) clearTimeout(this.photoRefPopupHideTimer);
    this.photoRefPopupHideTimer = setTimeout(() => {
      this.photoRefPopupVisible.set(false);
      this.photoRefHoveredEl = null;
      this.photoRefPopupHideTimer = null;
    }, 150);
  }

  hidePhotoRefPopup(): void {
    if (this.photoRefPopupHideTimer) clearTimeout(this.photoRefPopupHideTimer);
    if (this.photoRefPopupShowTimer) { clearTimeout(this.photoRefPopupShowTimer); this.photoRefPopupShowTimer = null; }
    this.photoRefPopupVisible.set(false);
    this.photoRefHoveredEl = null;
  }

  onPhotoRefPopupMouseEnter(): void {
    if (this.photoRefPopupHideTimer) { clearTimeout(this.photoRefPopupHideTimer); this.photoRefPopupHideTimer = null; }
  }

  onPhotoRefPopupMouseLeave(): void {
    this.scheduleHidePhotoRefPopup();
  }

  removePhotoReference(): void {
    const el = this.photoRefHoveredEl;
    if (!el) return;
    el.parentNode?.removeChild(el);
    this.hidePhotoRefPopup();
    const editorEl = this.editorRef?.nativeElement;
    if (editorEl) { this.editorContent = editorEl.innerHTML; this.scheduleEmit(); }
  }

  changePhotoReference(): void {
    const el = this.photoRefHoveredEl;
    if (!el) return;
    this.photoPickerChangingEl = el;
    const rect = el.getBoundingClientRect();
    const off = this.getFixedOffset();
    const PANEL_HEIGHT_EST = 300;
    const PANEL_WIDTH = 280;
    const GAP = 6;
    const above = rect.bottom + GAP + PANEL_HEIGHT_EST > window.innerHeight - off.y;
    this.photoPickerTop.set(above ? Math.max(GAP, rect.top - PANEL_HEIGHT_EST - GAP - off.y) : rect.bottom + GAP - off.y);
    this.photoPickerLeft.set(Math.max(GAP, Math.min(rect.left - off.x, window.innerWidth - PANEL_WIDTH - GAP)));
    this.photoPickerAbove.set(above);
    this.hidePhotoRefPopup();
    const entityId = el.getAttribute('data-entity-id') ?? '';
    const entity = this.entities().find(e => e.id === entityId) ?? null;
    const range = document.createRange();
    range.setStartBefore(el);
    range.collapse(true);
    this.photoPickerSavedRange = range;
    this.photoPickerEntityQuery.set('');
    this.photoPickerEntityFocusIndex.set(0);
    this.photoPickerSelectedEntity.set(entity);
    this.photoPickerStep.set(entity ? 'source' : 'entity');
    this.photoPickerUploading.set(false);
    this.photoPickerVisible.set(true);
    if (!entity) setTimeout(() => this.photoPickerEntityInputRef?.nativeElement.focus());
  }

  // ── Image resize ─────────────────────────────────────────────────────────

  private showFormattingToolbarForImage(img: HTMLImageElement): void {
    const rect = img.getBoundingClientRect();
    const off = this.getFixedOffset();
    const toolbarWidthCenter = 330;
    const toolbarWidthMax = 400;
    const editorRect = this.editorRef?.nativeElement?.getBoundingClientRect();
    const containerRight = editorRect ? (editorRect.right - off.x) : window.innerWidth;
    const left = Math.max(8, Math.min((rect.left - off.x) + rect.width / 2 - toolbarWidthCenter / 2, containerRight - toolbarWidthMax - 8));
    this.formattingToolbarTop.set(rect.top - off.y - 44);
    this.formattingToolbarLeft.set(left);
    this.formattingState.set({ bold: false, italic: false, underline: false, align: this.readImageAlign(img) });
    this.formattingToolbarVisible.set(true);
    this.formattingToolbarShownForImage = true;
  }

  private readImageAlign(img: HTMLImageElement): 'left' | 'center' | 'right' | 'justify' {
    const editor = this.editorRef?.nativeElement;
    let el: HTMLElement | null = img.parentElement;
    while (el && el !== editor) {
      const ta = el.style.textAlign;
      if (ta === 'center' || ta === 'right' || ta === 'justify') return ta as 'center' | 'right' | 'justify';
      if (ta === 'left') return 'left';
      el = el.parentElement;
    }
    return 'left';
  }

  private applyAlignToImage(img: HTMLImageElement, align: 'left' | 'center' | 'right' | 'justify'): void {
    const editor = this.editorRef?.nativeElement;
    let el: HTMLElement | null = img.parentElement;
    while (el && el !== editor) {
      const display = window.getComputedStyle(el).display;
      if (display === 'block' || display === 'flex' || display === 'table-cell') break;
      el = el.parentElement;
    }
    if (!el || el === editor) el = img.parentElement;
    if (!el) return;
    el.style.textAlign = align === 'left' ? '' : align;
    this.formattingState.update(s => ({ ...s, align }));
    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
  }

  private clearImageSelection(): void {
    this.editorRef?.nativeElement.querySelectorAll('img.image-selected').forEach(el => el.classList.remove('image-selected'));
    this.selectedImage.set(null);
    this.imageOverlayRect.set(null);
    if (this.formattingToolbarShownForImage) { this.formattingToolbarVisible.set(false); this.formattingToolbarShownForImage = false; }
  }

  private positionImageToolbar(img: HTMLImageElement): void {
    const rect = img.getBoundingClientRect();
    this.imageOverlayRect.set({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
  }

  onResizeHandleMouseDown(event: MouseEvent, direction: 'e' | 's' | 'se'): void {
    event.preventDefault(); event.stopPropagation();
    const img = this.selectedImage();
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const moveHandler = (e: MouseEvent) => this.onResizeMouseMove(e);
    const upHandler = () => this.onResizeMouseUp();
    this.resizeDrag = { direction, startX: event.clientX, startY: event.clientY, startWidth: rect.width, startHeight: rect.height, img, moveHandler, upHandler };
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  }

  private onResizeMouseMove(event: MouseEvent): void {
    if (!this.resizeDrag) return;
    const { direction, startX, startY, startWidth, startHeight, img } = this.resizeDrag;
    if (direction === 'e' || direction === 'se') { img.style.width = Math.max(20, startWidth + (event.clientX - startX)) + 'px'; img.removeAttribute('width'); }
    if (direction === 's' || direction === 'se') { img.style.height = Math.max(20, startHeight + (event.clientY - startY)) + 'px'; img.removeAttribute('height'); }
    const updated = img.getBoundingClientRect();
    this.imageOverlayRect.set({ top: updated.top, left: updated.left, width: updated.width, height: updated.height });
  }

  private onResizeMouseUp(): void {
    if (!this.resizeDrag) return;
    document.removeEventListener('mousemove', this.resizeDrag.moveHandler);
    document.removeEventListener('mouseup', this.resizeDrag.upHandler);
    const img = this.resizeDrag.img;
    this.resizeDrag = null;
    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
    this.positionImageToolbar(img);
  }

  // ── Context menu (Ctrl+.) ────────────────────────────────────────────────

  openCtxMenu(): void {
    const sel = window.getSelection();
    const selectedText = sel ? sel.toString() : '';
    const items: { id: string; label: string; icon: string }[] = [
      { id: 'ai-action', label: selectedText ? 'AI Reword' : 'AI Insert', icon: 'auto_awesome' },
    ];
    const quoteText = this.detectCursorInQuote();
    if (quoteText) {
      this.ctxMenuCaptureText = quoteText;
      this.ctxMenuNarratorCaptureText = '';
    } else {
      this.ctxMenuCaptureText = '';
      const narratorText = selectedText || this.extractCurrentLine();
      this.ctxMenuNarratorCaptureText = narratorText;
    }
    // Capture surrounding text now for quote-capture use cases
    const cursorRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const surroundingText = cursorRange ? this.extractSurroundingText(cursorRange) : '';

    // Append host-provided extra items
    for (const extra of this.ctxMenuExtraItems()) {
      if (this.ctxMenuCaptureText && extra.id === 'capture-quote') items.push(extra);
      else if (!this.ctxMenuCaptureText && extra.id === 'capture-narrator-quote' && this.ctxMenuNarratorCaptureText) items.push(extra);
      else if (extra.id !== 'capture-quote' && extra.id !== 'capture-narrator-quote') items.push(extra);
    }
    this._ctxMenuSurroundingText = surroundingText;
    this.ctxMenuItems.set(items);
    this.ctxMenuFocusedIndex.set(0);
    const rect = this.getCursorRect();
    const MENU_WIDTH = 200;
    const MENU_HEIGHT_EST = items.length * 44 + 8;
    const GAP = 6;
    const off = this.getFixedOffset();
    let top = 200, left = 40;
    if (rect && (rect.width !== 0 || rect.height !== 0 || rect.top !== 0)) {
      top = rect.bottom + GAP - off.y; left = rect.left - off.x;
      if (left + MENU_WIDTH > window.innerWidth - off.x - GAP) left = window.innerWidth - off.x - MENU_WIDTH - GAP;
      left = Math.max(GAP, left);
      if (top + MENU_HEIGHT_EST > window.innerHeight - off.y - GAP) top = rect.top - MENU_HEIGHT_EST - GAP - off.y;
      top = Math.max(GAP, top);
    }
    this.ctxMenuTop.set(top);
    this.ctxMenuLeft.set(left);
    this.ctxMenuVisible.set(true);
  }

  closeCtxMenu(): void { this.ctxMenuVisible.set(false); }

  executeCtxMenuItem(item: { id: string; label: string; icon: string } | undefined): void {
    if (!item) return;
    this.closeCtxMenu();
    if (item.id === 'ai-action') {
      this.requestAiAssist();
    } else {
      this.ctxMenuExtraItemSelected.emit({ id: item.id, captureText: this.ctxMenuCaptureText, narratorCaptureText: this.ctxMenuNarratorCaptureText, surroundingText: this._ctxMenuSurroundingText });
    }
  }

  /**
   * Extracts text beyond `keepLength` characters from `span` and places it
   * immediately after the span in the DOM. Used to move text that Chrome
   * snapped back into an AI-generated span after a sentence boundary.
   */
  private extractOverflowFromAiSpan(span: HTMLElement, keepLength: number): void {
    // Collect text nodes first so DOM mutation doesn't disrupt the walk.
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let tn: Text | null;
    while ((tn = walker.nextNode() as Text | null)) textNodes.push(tn);

    let walked = 0;
    const overflow = document.createDocumentFragment();
    let cutDone = false;
    let lastOverflowNode: Text | null = null;

    for (const node of textNodes) {
      const nodeLen = node.textContent?.length ?? 0;
      if (cutDone) {
        lastOverflowNode = node;
        overflow.appendChild(node); // moves node out of span automatically
      } else if (walked + nodeLen > keepLength) {
        const cutAt = keepLength - walked;
        if (cutAt < nodeLen) {
          const after = node.splitText(cutAt);
          lastOverflowNode = after;
          overflow.appendChild(after);
        }
        cutDone = true;
      }
      walked += nodeLen;
    }

    if (!overflow.hasChildNodes() || !lastOverflowNode) return;

    span.after(overflow);
    // Update threshold so the next input starts from the new end of the span.
    this.lastEjectedSpanTextLength = span.textContent?.length ?? 0;

    // Position cursor at the END of the last moved text node.
    // A text-node-offset cursor (unlike a parent-node-index cursor) is
    // unambiguous — Chrome will not snap subsequent keystrokes back into the
    // adjacent span, and the cursor won't reset to before previously typed chars.
    const sel = window.getSelection();
    if (sel && lastOverflowNode) {
      const range = document.createRange();
      range.setStart(lastOverflowNode, lastOverflowNode.textContent?.length ?? 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  /**
   * If the caret is inside a [data-ai-generated] span, splits the span at the
   * cursor and moves the caret to just after the span.  Any content that was
   * after the cursor inside the span is placed after the span as-is.
   * Returns true when an ejection was performed.
   */
  private ejectFromAiSpan(): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const aiSpan = (node.nodeType === Node.ELEMENT_NODE
      ? node as Element
      : (node as Text).parentElement)
      ?.closest<HTMLElement>('[data-ai-generated]');
    if (!aiSpan) return false;

    // Extract everything from the cursor to the end of the span.
    const splitRange = document.createRange();
    splitRange.setStart(range.startContainer, range.startOffset);
    splitRange.setEnd(aiSpan, aiSpan.childNodes.length);
    const tail = splitRange.extractContents();

    // Re-insert tail content immediately after the span.
    if (tail.hasChildNodes()) {
      aiSpan.after(tail);
    }

    // Position cursor using a parent-node index rather than a text-node anchor.
    // Chrome collapses zero-width / empty text nodes and re-snaps the cursor
    // back into the adjacent span.  A parent-node offset (setStart on the
    // containing block with a child index) is unambiguous: there is no inline
    // element at that position for the browser to snap into.
    const parent = aiSpan.parentNode!;
    const spanIdx = Array.from(parent.childNodes).indexOf(aiSpan as ChildNode);
    const newRange = document.createRange();
    newRange.setStart(parent, spanIdx + 1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    return true;
  }

  // ── Grammar check ────────────────────────────────────────────────────────

  scheduleGrammarCheck(): void {
    if (!this.userSettings.grammarCheckEnabled() && !this.userSettings.entityDetectionEnabled()) return;
    if (this.grammarTimer) clearTimeout(this.grammarTimer);
    this.grammarTimer = setTimeout(() => this.runGrammarCheck(), 750);
  }

  private async runGrammarCheck(): Promise<void> {
    this.grammarTimer = null;
    if (!this.editorRef) return;
    const editor = this.editorRef.nativeElement;
    const text = this.grammarService.extractCheckableText(editor);
    if (!text.trim()) { this.unwrapGrammarMarks(); this.grammarLastCheckedText = ''; return; }
    if (text === this.grammarLastCheckedText) return;
    this.grammarAbortController?.abort();
    this.grammarAbortController = new AbortController();

    const knownEntityNames = this.entities().flatMap(e =>
      [e.name, e.firstName, e.lastName, e.nickname].filter((n): n is string => !!n),
    );
    const { errors, suggestedEntities } = await this.grammarService.check(text, knownEntityNames, this.grammarAbortController.signal);
    this.grammarAbortController = null;
    this.grammarLastCheckedText = text;

    const savedCursor = this.saveCursorOffset(editor);
    this.unwrapGrammarMarks();
    if (this.userSettings.grammarCheckEnabled() && errors.length > 0) this.applyGrammarMarks(errors);
    this.restoreCursorOffset(editor, savedCursor);

    if (this.userSettings.entityDetectionEnabled()) {
      const fullText = (editor.innerText ?? '').toLowerCase();
      this.pendingSuggestions.update(prev =>
        prev.filter(c => c.created || c.creating || fullText.includes(c.name.toLowerCase())),
      );

      if (suggestedEntities.length > 0) {
        const knownLower = new Set(
          this.entities().flatMap(e =>
            [e.name, e.firstName, e.lastName, e.nickname].filter((n): n is string => !!n).map(n => n.toLowerCase()),
          ),
        );
        const newCards = suggestedEntities.filter(s => {
          const lower = s.name.toLowerCase();
          return !this.suggestedEntityNames.has(lower) && !knownLower.has(lower);
        });
        if (newCards.length > 0) this.pendingSuggestions.update(prev => [...prev, ...newCards]);
        suggestedEntities.forEach(s => this.suggestedEntityNames.add(s.name.toLowerCase()));
      }
    }
  }

  private saveCursorOffset(editor: HTMLElement): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return null;
    const measure = (node: Node, offset: number): number => {
      let chars = 0;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let n: Text | null;
      while ((n = walker.nextNode() as Text | null)) {
        if (n === node) return chars + offset;
        chars += n.length;
      }
      return chars;
    };
    return { start: measure(range.startContainer, range.startOffset), end: measure(range.endContainer, range.endOffset) };
  }

  private restoreCursorOffset(editor: HTMLElement, saved: { start: number; end: number } | null): void {
    if (!saved) return;
    const find = (target: number): { node: Text; offset: number } | null => {
      let chars = 0;
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let n: Text | null;
      while ((n = walker.nextNode() as Text | null)) {
        if (chars + n.length >= target) return { node: n, offset: target - chars };
        chars += n.length;
      }
      return null;
    };
    const startPos = find(saved.start);
    if (!startPos) return;
    const endPos = saved.start === saved.end ? startPos : (find(saved.end) ?? startPos);
    try {
      const range = document.createRange();
      range.setStart(startPos.node, startPos.offset);
      range.setEnd(endPos.node, saved.start === saved.end ? startPos.offset : endPos.offset);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    } catch { /* ignore if nodes shifted */ }
  }

  private unwrapGrammarMarks(): void {
    if (!this.editorRef) return;
    const editor = this.editorRef.nativeElement;
    const marks = editor.querySelectorAll('mark.grammar-error');
    if (marks.length === 0) return;
    marks.forEach(mark => {
      const parent = mark.parentNode!;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
    });
    editor.normalize();
  }

  private applyGrammarMarks(errors: GrammarError[]): void {
    for (const error of errors) this.markFirstOccurrence(error);
  }

  private markFirstOccurrence(error: GrammarError): void {
    if (!this.editorRef) return;
    const editor = this.editorRef.nativeElement;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node) => {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.entity-reference, .note-indicator, mark')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let textNode: Text | null;
    while ((textNode = walker.nextNode() as Text | null)) {
      const content = textNode.textContent ?? '';
      const idx = content.indexOf(error.text);
      if (idx === -1) continue;
      const range = document.createRange();
      range.setStart(textNode, idx);
      range.setEnd(textNode, idx + error.text.length);
      const mark = document.createElement('mark');
      mark.className = 'grammar-error';
      mark.setAttribute('data-grammar-suggestion', error.suggestion);
      mark.setAttribute('data-grammar-message', error.message);
      try { range.surroundContents(mark); } catch { /* skip */ }
      break;
    }
  }

  showGrammarPopover(event: MouseEvent, markEl: HTMLElement): void {
    const suggestion = markEl.getAttribute('data-grammar-suggestion') ?? '';
    const message = markEl.getAttribute('data-grammar-message') ?? '';
    this.grammarPopoverMarkEl = markEl;
    this.grammarPopoverError.set({ text: markEl.textContent ?? '', suggestion, message });
    const POPOVER_WIDTH = 280;
    const POPOVER_HEIGHT_EST = 130;
    const GAP = 6;
    const rect = markEl.getBoundingClientRect();
    const off = this.getFixedOffset();
    const left = Math.max(8, Math.min(rect.left - off.x, window.innerWidth - POPOVER_WIDTH - 8));
    const above = rect.bottom + GAP + POPOVER_HEIGHT_EST > window.innerHeight;
    this.grammarPopoverTop.set(above ? rect.top - GAP - off.y : rect.bottom + GAP - off.y);
    this.grammarPopoverLeft.set(left);
    this.grammarPopoverAbove.set(above);
    this.grammarPopoverVisible.set(true);
  }

  applyGrammarSuggestion(): void {
    const error = this.grammarPopoverError();
    const markEl = this.grammarPopoverMarkEl;
    if (!error || !markEl || !markEl.parentNode) return;
    const parent = markEl.parentNode!;
    const textNode = document.createTextNode(error.suggestion);
    parent.replaceChild(textNode, markEl);
    parent.normalize();
    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
    this.dismissGrammarPopover();
    this.scheduleGrammarCheck();
  }

  dismissGrammarPopover(): void {
    this.grammarPopoverVisible.set(false);
    this.grammarPopoverError.set(null);
    this.grammarPopoverMarkEl = null;
  }

  // ── Entity reference helpers ─────────────────────────────────────────────

  proxyUrl(azureUrl: string | undefined): string | null {
    if (!azureUrl) return null;
    const filename = azureUrl.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  openEntityEdit(entity: Entity): void {
    this.hoveredEntity.set(null);
    this.entityEditRequest.emit(entity);
  }

  private getReferenceType(entity: Entity, text: string): EntityReference {
    if (text === entity.name) return 'full-name';
    const refs = this.resolvedRefs(entity);
    if (refs.title) {
      if (text === `${refs.title} ${entity.name}`) return 'title-full-name';
      if (refs.lastName && text === `${refs.title} ${refs.lastName}`) return 'title-last-name';
    }
    if (refs.firstName && text === refs.firstName) return 'first-name';
    if (refs.lastName && text === refs.lastName) return 'last-name';
    if (refs.nickname && text === refs.nickname) return 'nickname';
    return 'other';
  }

  private getTextForReferenceType(entity: Entity, refType: EntityReference): string {
    const refs = this.resolvedRefs(entity);
    switch (refType) {
      case 'first-name': return refs.firstName || entity.name;
      case 'last-name': return refs.lastName || entity.name;
      case 'nickname': return refs.nickname || entity.name;
      case 'title-full-name': return refs.title ? `${refs.title} ${entity.name}` : entity.name;
      case 'title-last-name': return refs.title && refs.lastName ? `${refs.title} ${refs.lastName}` : entity.name;
      case 'other': return '';
      default: return entity.name;
    }
  }

  private syncEntityReferences(html: string, entities: Entity[]): string {
    if (!html) return html;
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll<HTMLElement>('span[data-id][data-reference-type]').forEach(span => {
      const entity = entities.find(e => e.id === span.getAttribute('data-id'));
      if (!entity) return;
      const refType = span.getAttribute('data-reference-type') as EntityReference;
      if (refType === 'other') return;
      const expected = this.getTextForReferenceType(entity, refType);
      if (span.textContent !== expected) span.textContent = expected;
    });
    return div.innerHTML;
  }

  private resolvedRefs(entity: Entity): { title?: string; firstName?: string; lastName?: string; nickname?: string } {
    if (entity.type !== 'PERSON') return { nickname: entity.nickname };
    const parts = entity.name.trim().split(/\s+/);
    return {
      title: entity.title,
      firstName: entity.firstName || (parts.length >= 2 ? parts[0] : undefined),
      lastName: entity.lastName || (parts.length >= 2 ? parts[parts.length - 1] : undefined),
      nickname: entity.nickname,
    };
  }

  private allRefsFor(entity: Entity): string[] {
    const refs = this.resolvedRefs(entity);
    const titleFullName = refs.title ? `${refs.title} ${entity.name}` : undefined;
    const titleLastName = refs.title && refs.lastName ? `${refs.title} ${refs.lastName}` : undefined;
    return [entity.name, refs.firstName, refs.lastName, refs.nickname, titleFullName, titleLastName].filter((v): v is string => !!v);
  }

  private getPreferredText(entity: Entity): string {
    const refs = this.resolvedRefs(entity);
    switch (entity.preferredReference) {
      case 'first-name': return refs.firstName || entity.name;
      case 'last-name': return refs.lastName || entity.name;
      case 'nickname': return refs.nickname || entity.name;
      case 'title-full-name': return refs.title ? `${refs.title} ${entity.name}` : entity.name;
      case 'title-last-name': return refs.title && refs.lastName ? `${refs.title} ${refs.lastName}` : entity.name;
      default: return entity.name;
    }
  }

  private entityMatchesWord(entity: Entity, lower: string): boolean {
    return this.allRefsFor(entity).some(v => v.toLowerCase().includes(lower));
  }

  buildEntityAnnotatedFragment(text: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const entities = this.entities().filter(e => !e.deleted && !e.archived);
    if (entities.length === 0) { fragment.appendChild(document.createTextNode(text)); return fragment; }
    type NameEntry = { name: string; entity: Entity; refType: EntityReference };
    const entries: NameEntry[] = [];
    for (const entity of entities) {
      for (const name of this.allRefsFor(entity)) entries.push({ name, entity, refType: this.getReferenceType(entity, name) });
    }
    entries.sort((a, b) => b.name.length - a.name.length);
    const escapedNames = entries.map(e => e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`\\b(${escapedNames.join('|')})\\b`, 'g');
    let lastIndex = 0, match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      const entry = entries.find(e => e.name === match![0]);
      if (entry) {
        const span = document.createElement('span');
        span.setAttribute('data-id', entry.entity.id);
        span.setAttribute('data-reference-type', entry.refType);
        span.className = 'entity-reference';
        span.textContent = match![0];
        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(match[0]));
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    return fragment;
  }

  private wrapEntityReferencesInEditor(entity: Entity): void {
    if (!this.editorRef) return;
    const editor = this.editorRef.nativeElement;
    this.unwrapGrammarMarks();
    const variants = this.buildEntityVariants(entity);
    if (variants.length === 0) return;
    const pattern = variants.map(v => v.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const searchRegex = new RegExp(pattern, 'gi');
    const variantMap = new Map<string, EntityReference>(variants.map(v => [v.text.toLowerCase(), v.refType]));
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node) => {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.entity-reference, .note-indicator')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes: Text[] = [];
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      searchRegex.lastIndex = 0;
      if (searchRegex.test(node.textContent ?? '')) textNodes.push(node);
    }
    for (const textNode of textNodes) {
      const content = textNode.textContent ?? '';
      const parent = textNode.parentNode!;
      const fragment = document.createDocumentFragment();
      let lastIdx = 0;
      let match: RegExpExecArray | null;
      searchRegex.lastIndex = 0;
      while ((match = searchRegex.exec(content)) !== null) {
        if (match.index > lastIdx) fragment.appendChild(document.createTextNode(content.slice(lastIdx, match.index)));
        const refType = variantMap.get(match[0].toLowerCase()) ?? 'full-name';
        const span = document.createElement('span');
        span.className = 'entity-reference';
        span.setAttribute('data-id', entity.id);
        span.setAttribute('data-reference-type', refType);
        span.textContent = match[0];
        fragment.appendChild(span);
        lastIdx = match.index + match[0].length;
      }
      if (lastIdx < content.length) fragment.appendChild(document.createTextNode(content.slice(lastIdx)));
      parent.replaceChild(fragment, textNode);
    }
    editor.normalize();
    this.editorContent = editor.innerHTML;
    this.scheduleEmit();
    this.scheduleGrammarCheck();
  }

  private buildEntityVariants(entity: Entity): { text: string; refType: EntityReference }[] {
    const refs = this.resolvedRefs(entity);
    const pairs: { text: string; refType: EntityReference }[] = [];
    const seen = new Set<string>();
    const add = (text: string | undefined, refType: EntityReference) => {
      if (text?.trim() && !seen.has(text.toLowerCase())) { seen.add(text.toLowerCase()); pairs.push({ text, refType }); }
    };
    if (refs.title) add(`${refs.title} ${entity.name}`, 'title-full-name');
    if (refs.title && refs.lastName) add(`${refs.title} ${refs.lastName}`, 'title-last-name');
    add(entity.name, 'full-name');
    if (refs.firstName && refs.lastName) add(`${refs.firstName} ${refs.lastName}`, 'full-name');
    add(refs.nickname, 'nickname');
    add(refs.firstName, 'first-name');
    add(refs.lastName, 'last-name');
    return pairs.sort((a, b) => b.text.length - a.text.length);
  }

  // ── Selection / cursor utilities ─────────────────────────────────────────

  private checkAutocomplete(): void {
    const result = this.getCurrentWordAtCursor();
    if (!result || result.word.length < 2) { this.autocompleteItems.set([]); this.currentWordRange = null; return; }
    const lower = result.word.toLowerCase();
    const flat: { entity: Entity; text: string; isPreferred: boolean }[] = [];
    for (const entity of this.entities()) {
      if (!this.entityMatchesWord(entity, lower)) continue;
      const preferred = this.getPreferredText(entity);
      const seen = new Set<string>([preferred]);
      flat.push({ entity, text: preferred, isPreferred: true });
      for (const v of this.allRefsFor(entity)) {
        if (!seen.has(v)) { seen.add(v); flat.push({ entity, text: v, isPreferred: false }); }
      }
    }
    if (flat.length === 0) { this.autocompleteItems.set([]); this.currentWordRange = null; return; }
    this.currentWordRange = result.range;
    this.autocompleteIndex.set(0);
    this.autocompleteItems.set(flat);
    const rect = this.getCursorRect();
    if (rect) {
      const DROPDOWN_MAX_HEIGHT = 240;
      const GAP = 4;
      const off = this.getFixedOffset();
      const above = rect.bottom + GAP + DROPDOWN_MAX_HEIGHT > window.innerHeight;
      this.autocompleteAbove.set(above);
      this.autocompleteTop.set(above ? rect.top - GAP - off.y : rect.bottom + GAP - off.y);
      this.autocompleteLeft.set(rect.left - off.x);
    }
  }

  private getCurrentWordAtCursor(): { word: string; range: Range } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE) return null;
    const text = container.textContent ?? '';
    const offset = range.startOffset;
    let start = offset;
    while (start > 0 && !/[\s\n]/.test(text[start - 1])) start--;
    const word = text.substring(start, offset);
    if (!word) return null;
    const wordRange = range.cloneRange();
    wordRange.setStart(container, start);
    wordRange.setEnd(container, offset);
    return { word, range: wordRange };
  }

  private getCursorRect(): DOMRect | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    let rect = range.getBoundingClientRect();
    // Collapsed range on an empty line returns a zero rect — fall back to
    // inserting a temporary zero-width char to measure position
    if (!rect || (rect.top === 0 && rect.left === 0 && rect.width === 0 && rect.height === 0)) {
      const tmp = document.createTextNode('\u200b');
      range.insertNode(tmp);
      rect = range.getBoundingClientRect();
      tmp.parentNode?.removeChild(tmp);
    }
    return rect;
  }

  private extractSurroundingText(range: Range): string {
    const editor = this.editorRef?.nativeElement;
    if (!editor) return '';
    const fullText = editor.innerText ?? '';
    const preRange = document.createRange();
    preRange.setStart(editor, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    const cursorOffset = preRange.toString().length;
    const RADIUS = 300;
    const rawBefore = fullText.slice(Math.max(0, cursorOffset - RADIUS), cursorOffset);
    const rawAfter = fullText.slice(cursorOffset, cursorOffset + RADIUS);
    const sentenceStart = rawBefore.search(/[.!?]\s+(?=[A-Z])[^]*$/);
    const before = sentenceStart >= 0 ? rawBefore.slice(sentenceStart + 1).trim() : rawBefore.trim();
    const sentenceEnd = rawAfter.search(/[.!?]\s/);
    const after = sentenceEnd >= 0 ? rawAfter.slice(0, sentenceEnd + 1).trim() : rawAfter.trim();
    if (!before && !after) return '';
    return before + ' [CURSOR] ' + after;
  }

  private extractCurrentLine(): string {
    const editor = this.editorRef?.nativeElement;
    if (!editor) return '';
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.setStart(editor, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    const cursorOffset = preRange.toString().length;
    const fullText = editor.innerText ?? '';
    const sentenceEndRe = /[.!?][\s\n]/g;
    let sentenceStart = 0;
    let m: RegExpExecArray | null;
    while ((m = sentenceEndRe.exec(fullText)) !== null) {
      if (m.index + m[0].length > cursorOffset) break;
      sentenceStart = m.index + m[0].length;
    }
    sentenceEndRe.lastIndex = cursorOffset;
    const endMatch = sentenceEndRe.exec(fullText);
    const sentenceEnd = endMatch ? endMatch.index + 1 : fullText.length;
    return fullText.slice(sentenceStart, sentenceEnd).trim();
  }

  private detectCursorInQuote(): string | null {
    const editor = this.editorRef?.nativeElement;
    if (!editor) return null;
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.setStart(editor, 0);
    preRange.setEnd(range.startContainer, range.startOffset);
    const cursorOffset = preRange.toString().length;
    const fullText = editor.innerText ?? '';
    const lineStart = Math.max(0, fullText.lastIndexOf('\n', cursorOffset - 1) + 1);
    const lineEndIdx = fullText.indexOf('\n', cursorOffset);
    const lineText = fullText.slice(lineStart, lineEndIdx < 0 ? fullText.length : lineEndIdx);
    const cursorInLine = cursorOffset - lineStart;
    const justAfterCurly = cursorInLine > 0 && lineText[cursorInLine - 1] === '\u201D';
    const beforeCursorStr = lineText.slice(0, cursorInLine);
    const justAfterStraight = cursorInLine > 0 && lineText[cursorInLine - 1] === '"' && (beforeCursorStr.match(/"/g) ?? []).length % 2 === 0;
    const searchUpTo = justAfterCurly ? cursorInLine - 1 : cursorInLine;
    const openCurly = lineText.lastIndexOf('\u201C', searchUpTo - 1);
    const closeCurly = justAfterCurly ? cursorInLine - 1 : lineText.indexOf('\u201D', cursorInLine);
    if (openCurly >= 0 && closeCurly >= 0) return lineText.slice(openCurly + 1, closeCurly).trim() || null;
    if (justAfterStraight) {
      const closePos = cursorInLine - 1;
      const openPos = beforeCursorStr.slice(0, closePos).lastIndexOf('"');
      if (openPos >= 0) return lineText.slice(openPos + 1, closePos).trim() || null;
    }
    const straightCount = (beforeCursorStr.match(/"/g) ?? []).length;
    if (straightCount % 2 === 1) {
      const openPos = beforeCursorStr.lastIndexOf('"');
      const closePos = lineText.indexOf('"', cursorInLine);
      if (closePos >= 0) return lineText.slice(openPos + 1, closePos).trim() || null;
    }
    return null;
  }

  private scrollCursorIntoView(): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !this.editorRef) return;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);
    const span = document.createElement('span');
    range.insertNode(span);
    span.scrollIntoView({ block: 'center', behavior: 'smooth' });
    span.remove();
  }

  // ── Minimap ───────────────────────────────────────────────────────────────

  onMinimapMouseDown(event: MouseEvent): void {
    event.preventDefault();
    this.minimapDragging = true;
    this.minimapScrollTo(event.offsetY);
  }

  onMinimapMouseMove(event: MouseEvent): void {
    if (!this.minimapDragging) return;
    this.minimapScrollTo(event.offsetY);
  }

  private minimapScrollTo(minimapY: number): void {
    const editor = this.editorRef?.nativeElement;
    if (!editor) return;
    const H = editor.clientHeight;
    if (H <= 0) return;
    const fraction = Math.max(0, Math.min(1, minimapY / H));
    editor.scrollTop = fraction * editor.scrollHeight - editor.clientHeight / 2;
    this.renderMinimap();
  }

  private scheduleMinimap(): void {
    if (this.minimapRenderTimer) clearTimeout(this.minimapRenderTimer);
    this.minimapRenderTimer = setTimeout(() => {
      this.minimapRenderTimer = null;
      this.renderMinimap();
    }, 40);
  }

  private renderMinimap(): void {
    if (!this.minimapCanvasRef?.nativeElement || !this.editorRef?.nativeElement) return;
    const canvas = this.minimapCanvasRef.nativeElement;
    const editor = this.editorRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = this.MINIMAP_WIDTH;
    const H = editor.clientHeight;
    if (H <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(W * dpr);
    const targetH = Math.round(H * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const totalH = editor.scrollHeight;
    if (totalH <= 0) return;
    const scale = H / totalH;

    // Background: read from the minimap container so the browser resolves light-dark() and
    // CSS variables before we hand the value to canvas, which cannot parse them itself.
    const minimapDiv = canvas.parentElement!;
    const minimapBgComputed = getComputedStyle(minimapDiv).backgroundColor;
    const bgIsTransparent = !minimapBgComputed || minimapBgComputed === 'transparent' || minimapBgComputed === 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = bgIsTransparent ? '#f4f4f4' : minimapBgComputed;
    ctx.fillRect(0, 0, W, H);

    // Determine dark vs light from background luminance and pick a contrasting bar colour.
    // getComputedStyle(editor).color is unreliable when the theme uses light-dark() — the
    // resolved value may be the wrong polarity due to colour-scheme inheritance.
    const [bgr, bgg, bgb] = this.minimapParseRgb(ctx.fillStyle as string);
    const bgLum = (0.299 * bgr + 0.587 * bgg + 0.114 * bgb) / 255;
    const isDark = bgLum < 0.45;
    const [tr, tg, tb] = isDark ? [210, 210, 220] : [40, 42, 54];

    // Use getBoundingClientRect for reliable positions within the scroll container.
    // offsetParent skips statically-positioned elements so it cannot be used here.
    const editorRect = editor.getBoundingClientRect();

    // Build logical rows from the editor's child NODES — not just element children.
    // Content loaded from stored HTML often places a paragraph's text as loose
    // top-level text nodes interleaved with inline <span class="entity-reference">
    // elements, with no wrapping <div>/<p> (Chrome only inserts <div> as you press
    // Enter). Iterating editor.children would skip the loose text entirely and
    // mis-render each inline span as its own block — which is why the first paragraph
    // collapsed to a couple of stray bars. So: group consecutive inline/text nodes
    // into one synthetic row, treat <div>/<p>/<h*> as block rows, and expand
    // <ul>/<ol> into their <li> rows.
    const BLOCK_TAGS = /^(?:DIV|P|H[1-6]|LI|BLOCKQUOTE|PRE)$/;
    const isBlockEl = (n: Node): n is HTMLElement =>
      n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.test((n as HTMLElement).tagName);

    const collectTextNodes = (root: Node): Text[] => {
      if (root.nodeType === Node.TEXT_NODE) return [root as Text];
      if (root.nodeType !== Node.ELEMENT_NODE) return [];
      const out: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let t: Node | null;
      while ((t = walker.nextNode())) out.push(t as Text);
      return out;
    };

    interface MinimapRow {
      range: Range;
      boundingRect: DOMRect;
      height: number;
      textNodes: Text[];
      isHeading: boolean;
      hasImg: boolean;
    }
    const rows: MinimapRow[] = [];

    const pushBlockRow = (el: HTMLElement): void => {
      const range = document.createRange();
      range.selectNodeContents(el);
      rows.push({
        range,
        boundingRect: el.getBoundingClientRect(),
        height: el.offsetHeight,
        textNodes: collectTextNodes(el),
        isHeading: /^H[1-6]$/.test(el.tagName),
        hasImg: !!el.querySelector('img'),
      });
    };

    // Consecutive loose inline/text nodes form one visual paragraph.
    let inlineRun: Node[] = [];
    const flushInlineRun = (): void => {
      const meaningful = inlineRun.filter(n => (n.textContent ?? '') !== '' || n.nodeName === 'IMG');
      inlineRun = [];
      if (meaningful.length === 0) return;
      const range = document.createRange();
      range.setStartBefore(meaningful[0]);
      range.setEndAfter(meaningful[meaningful.length - 1]);
      rows.push({
        range,
        boundingRect: range.getBoundingClientRect(),
        height: range.getBoundingClientRect().height,
        textNodes: meaningful.flatMap(collectTextNodes),
        isHeading: false,
        hasImg: meaningful.some(n =>
          n.nodeName === 'IMG' ||
          (n.nodeType === Node.ELEMENT_NODE && !!(n as HTMLElement).querySelector?.('img'))),
      });
    };

    for (const node of Array.from(editor.childNodes)) {
      const tag = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement).tagName : '';
      if (tag === 'UL' || tag === 'OL') {
        flushInlineRun();
        for (const li of Array.from((node as HTMLElement).children)) pushBlockRow(li as HTMLElement);
      } else if (isBlockEl(node)) {
        flushInlineRun();
        pushBlockRow(node);
      } else {
        inlineRun.push(node);
      }
    }
    flushInlineRun();

    // line-height resolves to px on the editor (set via unitless 1.75); use it for
    // both the line-merge tolerance and the fallback path below.
    const editorLineH = parseFloat(getComputedStyle(editor).lineHeight) || 20;

    for (const row of rows) {
      // Images are ignored in the minimap — only render rows that contain text.
      if (!row.textNodes.some(t => t.textContent?.trim())) continue;

      const blockRect = row.boundingRect;
      const offsetTop = blockRect.top - editorRect.top + editor.scrollTop;
      const blockH = row.height;
      if (blockH <= 0) continue;

      const yTop = offsetTop * scale;
      if (yTop > H) continue;

      const isHeading = row.isHeading;
      const indent = isHeading ? 2 : 4;
      const maxLineW = W - indent * 2;
      const opacity = isHeading ? 0.78 : 0.55;
      ctx.fillStyle = `rgba(${tr},${tg},${tb},${opacity})`;

      // Use the browser's actual line layout via Range.getClientRects().
      // This gives exact Y positions and text widths for every wrapped line.
      const rawRects = Array.from(row.range.getClientRects());

      // Merge rects that share the same visual line. Tolerance is 40 % of the line
      // height: adjacent lines sit ~lineH apart, so staying under 50 % keeps inline
      // fragments (entity spans, etc.) on one line without merging separate lines.
      const mergeTol = editorLineH * 0.4;

      const lineGroups: { top: number; minLeft: number; maxRight: number; height: number }[] = [];
      for (const r of rawRects) {
        if (r.width < 2 || r.height < 2) continue;
        const existing = lineGroups.find(l => Math.abs(l.top - r.top) < mergeTol);
        if (existing) {
          existing.minLeft = Math.min(existing.minLeft, r.left);
          existing.maxRight = Math.max(existing.maxRight, r.right);
        } else {
          lineGroups.push({ top: r.top, minLeft: r.left, maxRight: r.right, height: r.height });
        }
      }
      lineGroups.sort((a, b) => a.top - b.top);

      if (lineGroups.length === 0) continue;

      const blockLeft = blockRect.left;
      const blockWidth = blockRect.width || 1;

      // A leading \t with white-space:pre-wrap renders as dead space, but
      // getClientRects() starts the line rect AT the tab character (blockLeft),
      // not after it — so minLeft always equals blockLeft for indented first lines.
      // Fix: walk to the first non-whitespace character and measure its exact
      // viewport left with a targeted single-char Range.
      let firstVisibleLeft = blockLeft;
      wsLoop: for (const wsNode of row.textNodes) {
        const txt = wsNode.textContent ?? '';
        for (let ci = 0; ci < txt.length; ci++) {
          if (!/\s/.test(txt[ci])) {
            const cr = document.createRange();
            cr.setStart(wsNode, ci);
            cr.setEnd(wsNode, ci + 1);
            const crRect = cr.getClientRects()[0];
            if (crRect) firstVisibleLeft = crRect.left;
            break wsLoop;
          }
        }
      }

      for (const line of lineGroups) {
        // Map viewport Y → document-absolute Y → minimap Y
        const lineDocTop = offsetTop + (line.top - blockRect.top);
        const miniY = lineDocTop * scale;
        if (miniY < 0 || miniY > H) continue;

        // First line uses the measured first-visible-char position so that
        // leading tabs produce a real indent; continuation lines use minLeft.
        const effectiveLeft = (line === lineGroups[0]) ? firstVisibleLeft : line.minLeft;
        const rawRelLeft = Math.max(0, effectiveLeft - blockLeft);
        // A tab in a wide editor column scales to only ~2–3 px in the minimap.
        // Amplify the indent 4× so it reads clearly; cap in block pixel space
        // (same units as rawRelLeft) to avoid the value being divided away.
        const relLeft = (line === lineGroups[0] && rawRelLeft > 0)
          ? Math.min(rawRelLeft * 4, blockWidth * 0.22)
          : rawRelLeft;
        const relRight = Math.min(blockWidth, line.maxRight - blockLeft);
        const lineX = indent + (relLeft / blockWidth) * maxLineW;
        const lineW = Math.max(2, ((relRight - relLeft) / blockWidth) * maxLineW);
        // Use ~50% of the line's allocated space so individual lines are
        // distinguishable and gaps between paragraphs are clearly visible.
        const miniH = Math.max(1.5, Math.min(line.height * scale * 0.5, 3.5));

        ctx.fillRect(lineX, miniY, lineW, miniH);
      }
    }

    // Fallback: editor has raw text not wrapped in any child elements
    if (rows.length === 0 && editor.textContent?.trim()) {
      const lineH = parseFloat(getComputedStyle(editor).lineHeight) || 20;
      const numLines = Math.round(totalH / lineH);
      const miniLineH = Math.max(1, lineH * scale);
      const miniLineBarH = Math.max(1.5, Math.min(miniLineH * 0.5, 3.5));
      ctx.fillStyle = `rgba(${tr},${tg},${tb},0.5)`;
      for (let i = 0; i < numLines; i++) {
        const lineY = i * miniLineH;
        if (lineY > H) break;
        ctx.fillRect(4, lineY, W - 12, miniLineBarH);
      }
    }

    // Viewport indicator — probe --mat-sys-primary via a temporary element so the browser
    // resolves light-dark() before we pass the colour to canvas.
    const primaryProbe = document.createElement('span');
    primaryProbe.style.cssText = 'display:none;color:var(--mat-sys-primary,#005cbb)';
    document.body.appendChild(primaryProbe);
    const primaryResolved = getComputedStyle(primaryProbe).color;
    document.body.removeChild(primaryProbe);
    const [pr, pg, pb] = this.minimapParseRgb(primaryResolved);
    const vpTop = (editor.scrollTop / totalH) * H;
    const vpH = Math.max(12, (editor.clientHeight / totalH) * H);
    ctx.fillStyle = `rgba(${pr},${pg},${pb},0.18)`;
    ctx.fillRect(0, vpTop, W, vpH);
    ctx.strokeStyle = `rgba(${pr},${pg},${pb},0.65)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, vpTop + 0.5, W - 1, vpH - 1);
  }

  private minimapParseRgb(color: string): [number, number, number] {
    // Handle hex shorthand (#rgb) and full hex (#rrggbb / #rrggbbaa)
    const hexMatch = color.trim().match(/^#([0-9a-f]{3,8})$/i);
    if (hexMatch) {
      const h = hexMatch[1];
      if (h.length === 3 || h.length === 4) {
        return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
      }
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    // Handle rgb/rgba (comma or space-separated)
    const m = color.match(/\d+/g);
    if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
    return [100, 100, 180]; // fallback blue-ish
  }

  private scheduleEmit(): void {
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.contentChange.emit(this.editorContent);
    }, 800);
  }
}
