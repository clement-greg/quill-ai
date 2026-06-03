import {
  Component, inject, signal, computed, effect, untracked,
  OnInit, AfterViewInit, OnDestroy, ViewChild, ElementRef, HostListener, input, output,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Entity, EntityReference } from '@shared/models/entity.model';
import { EntityService } from '../../services/entity.service';
import { GrammarCheckService, GrammarError, SuggestedEntity } from '../../services/grammar-check.service';
import { UserSettingsService, GhostCompleteItem } from '../../services/user-settings.service';

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
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './rich-text-editor.html',
  styleUrl: './rich-text-editor.scss',
})
export class RichTextEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('editorEl') editorRef!: ElementRef<HTMLDivElement>;
  @ViewChild('inlineAiInputEl') inlineAiInputEl?: ElementRef<HTMLInputElement>;
  @ViewChild('inlineAiPanelEl') inlineAiPanelRef?: ElementRef<HTMLElement>;
  @ViewChild('minimapCanvas') minimapCanvasRef?: ElementRef<HTMLCanvasElement>;

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

  // ── Inline AI ────────────────────────────────────────────────────────────
  inlineAiVisible = signal(false);
  inlineAiTop = signal(0);
  inlineAiLeft = signal(0);
  inlineAiAbove = signal(false);
  inlineAiInput = signal('');
  inlineAiResponse = signal('');
  inlineAiStreaming = signal(false);
  inlineAiSelectedText = signal('');
  inlineAiImageUrl = signal<string | null>(null);
  inlineAiGeneratingImage = signal(false);

  ghostSuggestion = computed(() => {
    const inputVal = this.inlineAiInput();
    if (!inputVal || this.inlineAiSelectedText()) return null;
    const lower = inputVal.toLowerCase();
    return this.userSettings.ghostCompleteItems().find(
      item => item.prompt.toLowerCase().startsWith(lower) && item.prompt.length > inputVal.length,
    ) ?? null;
  });
  ghostSuffix = computed(() => {
    const s = this.ghostSuggestion();
    return s ? s.prompt.slice(this.inlineAiInput().length) : '';
  });

  private inlineAiCursorRange: Range | null = null;
  private inlineAiCharBefore = '';
  private inlineAiCharAfter = '';
  private inlineAiSurroundingText = '';
  private inlineAiAbortController: AbortController | null = null;
  private inlineAiAnchorRect: DOMRect | null = null;
  private inlineAiResizeObserver: ResizeObserver | null = null;

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
    this.grammarAbortController?.abort();
    this.inlineAiAbortController?.abort();
    this.inlineAiResizeObserver?.disconnect();
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
    if (this.editorRef) this.editorRef.nativeElement.innerHTML = html;
    setTimeout(() => this.scheduleMinimap());
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

    let range = this.externalInsertRange;
    if (!range || !editorEl.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editorEl);
      range.collapse(false);
    }

    const wrapper = document.createElement('span');
    wrapper.setAttribute('data-ai-generated', 'true');
    wrapper.textContent = text;

    range.deleteContents();
    range.insertNode(wrapper);

    const ar = document.createRange();
    ar.setStartAfter(wrapper);
    ar.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(ar); }

    editorEl.focus();
    this.scrollCursorIntoView();
    this.editorContent = editorEl.innerHTML;
    this.scheduleEmit();
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

  /** Returns the bounding rect of the current selection, or null. */
  getSelectionRect(): DOMRect | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    return sel.getRangeAt(0).getBoundingClientRect();
  }

  // ── Content input handler ────────────────────────────────────────────────

  onContentInput(event: Event): void {
    const el = event.target as HTMLDivElement;
    this.editorContent = el.innerHTML;

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

    let cleanHtml: string;
    if (html) {
      cleanHtml = this.cleanPastedHtml(html);
    } else {
      cleanHtml = text
        .split('\n')
        .map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>'}</p>`)
        .join('');
    }

    // execCommand keeps the operation on the browser's native undo stack so
    // Ctrl+Z works as expected.
    document.execCommand('insertHTML', false, cleanHtml);

    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
    this.scheduleMinimap();
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
    return body.innerHTML;
  }

  // ── Keyboard handler ─────────────────────────────────────────────────────

  onEditorKeyDown(event: KeyboardEvent): void {
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
    // Show/update the formatting toolbar when the selection changes via keyboard.
    // Covers Shift+arrows, releasing Shift after a selection, and Ctrl+A.
    const isSelectionKey = event.shiftKey || event.key === 'Shift'
      || (event.key === 'a' && (event.ctrlKey || event.metaKey));
    if (isSelectionKey) {
      setTimeout(() => this.updateFormattingToolbar());
    }
  }

  onEditorMouseMove(event: MouseEvent): void {
    const target = event.target as HTMLElement;
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

  onEditorMouseLeave(): void { this.scheduleHidePopup(); }
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
      this.openInlineAiPrompt();
    }, 600);
  }

  onEditorTouchEnd(): void { if (this.longPressTimer !== null) { clearTimeout(this.longPressTimer); this.longPressTimer = null; } }
  onEditorTouchMove(): void { if (this.longPressTimer !== null) { clearTimeout(this.longPressTimer); this.longPressTimer = null; } }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.rte-autocomplete-dropdown')) { this.autocompleteItems.set([]); this.currentWordRange = null; }
    if (!target.closest('.rte-formatting-toolbar')) { this.formattingToolbarVisible.set(false); }
    if (this.inlineAiVisible() && !target.closest('.rte-inline-ai-prompt')) this.dismissInlineAiPrompt();
    if (this.grammarPopoverVisible() && !target.closest('.rte-grammar-popover')) this.dismissGrammarPopover();
    if (this.ctxMenuVisible() && !target.closest('.rte-ctx-menu')) this.closeCtxMenu();
    if (this.selectedImage() && target.tagName !== 'IMG' && !target.closest('.rte-image-resize-overlay')) this.clearImageSelection();
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
    const toolbarWidth = 290;
    const off = this.getFixedOffset();
    const left = (rect.left - off.x) + rect.width / 2 - toolbarWidth / 2;
    this.formattingToolbarTop.set(rect.top - off.y - 44);
    this.formattingToolbarLeft.set(Math.max(8, left));
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

  // ── Image resize ─────────────────────────────────────────────────────────

  private showFormattingToolbarForImage(img: HTMLImageElement): void {
    const rect = img.getBoundingClientRect();
    const off = this.getFixedOffset();
    const toolbarWidth = 290;
    const left = Math.max(8, Math.min((rect.left - off.x) + rect.width / 2 - toolbarWidth / 2, window.innerWidth - toolbarWidth - 8));
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
      this.openInlineAiPrompt();
    } else {
      this.ctxMenuExtraItemSelected.emit({ id: item.id, captureText: this.ctxMenuCaptureText, narratorCaptureText: this.ctxMenuNarratorCaptureText, surroundingText: this._ctxMenuSurroundingText });
    }
  }

  // ── Inline AI prompt ─────────────────────────────────────────────────────

  openInlineAiPrompt(): void {
    const sel = window.getSelection();
    this.inlineAiCharBefore = '';
    this.inlineAiCharAfter = '';
    this.inlineAiSurroundingText = '';
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      this.inlineAiCursorRange = r.cloneRange();
      this.inlineAiSelectedText.set(sel.toString());
      const sc = r.startContainer;
      if (sc.nodeType === Node.TEXT_NODE && r.startOffset > 0) this.inlineAiCharBefore = (sc.textContent ?? '')[r.startOffset - 1] ?? '';
      const ec = r.endContainer;
      if (ec.nodeType === Node.TEXT_NODE) this.inlineAiCharAfter = (ec.textContent ?? '')[r.endOffset] ?? '';
      this.inlineAiSurroundingText = this.extractSurroundingText(r);
    } else {
      this.inlineAiCursorRange = null;
      this.inlineAiSelectedText.set('');
    }
    this.inlineAiInput.set('');
    this.inlineAiResponse.set('');
    this.inlineAiVisible.set(true);
    this.insertAiMarker();
    const marker = this.editorRef?.nativeElement?.querySelector('.ai-insertion-marker');
    const rect = marker?.getBoundingClientRect() ?? this.getCursorRect();
    const PANEL_WIDTH = 388;
    const PANEL_HEIGHT_EST = 140;
    const GAP = 10;
    const off = this.getFixedOffset();
    let top: number, left: number, above = false;
    if (rect && (rect.top !== 0 || rect.left !== 0 || rect.width !== 0 || rect.height !== 0)) {
      // Prefer to open below and to the right of the cursor
      const anchorX = rect.left + rect.width - off.x;
      const anchorBottom = rect.bottom - off.y;
      const anchorTop = rect.top - off.y;

      // Horizontal: start at cursor position, clamp to viewport
      left = anchorX;
      if (left + PANEL_WIDTH + GAP > window.innerWidth - off.x) {
        // Not enough room to the right — align right edge to cursor
        left = anchorX - PANEL_WIDTH;
      }
      left = Math.max(GAP, Math.min(left, window.innerWidth - off.x - PANEL_WIDTH - GAP));

      // Vertical: prefer below cursor, flip above if not enough room
      if (anchorBottom + GAP + PANEL_HEIGHT_EST <= window.innerHeight - off.y) {
        top = anchorBottom + GAP;
        above = false;
      } else {
        top = anchorTop - GAP;
        above = true;
      }
      top = Math.max(GAP, top);
    } else {
      const editorRect = this.editorRef?.nativeElement?.getBoundingClientRect();
      top = editorRect ? editorRect.top + 60 - off.y : 200;
      left = editorRect ? editorRect.left + 40 - off.x : 200;
    }
    this.inlineAiAnchorRect = rect ?? null;
    this.inlineAiTop.set(top);
    this.inlineAiLeft.set(left);
    this.inlineAiAbove.set(above);
    setTimeout(() => {
      this.inlineAiInputEl?.nativeElement?.focus();
      const panelEl = this.inlineAiPanelRef?.nativeElement;
      if (panelEl) {
        this.inlineAiResizeObserver?.disconnect();
        this.inlineAiResizeObserver = new ResizeObserver(() => this.repositionInlineAiPanel());
        this.inlineAiResizeObserver.observe(panelEl);
      }
    });
  }

  private repositionInlineAiPanel(): void {
    const rect = this.inlineAiAnchorRect;
    const panelEl = this.inlineAiPanelRef?.nativeElement;
    if (!rect || !panelEl) return;
    const GAP = 10;
    const off = this.getFixedOffset();
    const panelHeight = panelEl.offsetHeight;
    let top: number, above: boolean;
    if (rect.bottom + GAP + panelHeight <= window.innerHeight) { top = rect.bottom + GAP - off.y; above = false; }
    else { top = rect.top - GAP - off.y; above = true; }
    this.inlineAiTop.set(Math.max(GAP, top));
    this.inlineAiAbove.set(above);
  }

  onInlineAiKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && this.ghostSuggestion()) { event.preventDefault(); this.applyGhostComplete(this.ghostSuggestion()!); return; }
    if (event.key === 'Enter') { event.preventDefault(); this.submitInlineAiPrompt(); }
    else if (event.key === 'Escape') { this.dismissInlineAiPrompt(); }
    else if (event.key === 'a' && event.altKey && !this.inlineAiStreaming() && (this.inlineAiResponse() || this.inlineAiImageUrl())) { event.preventDefault(); this.acceptInlineAiResponse(); }
  }

  applyGhostComplete(item: GhostCompleteItem): void { this.inlineAiInput.set(item.prompt); }
  onInlineAiInputChange(value: string): void { this.inlineAiInput.set(value); }

  async submitInlineAiPrompt(): Promise<void> {
    const text = this.inlineAiInput().trim();
    const selectedText = this.inlineAiSelectedText();
    if ((!text && !selectedText) || this.inlineAiStreaming()) return;

    this.inlineAiResponse.set('');
    this.inlineAiImageUrl.set(null);
    this.inlineAiStreaming.set(true);

    if (!selectedText && this.isImageRequest(text)) {
      this.inlineAiGeneratingImage.set(true);
      try {
        const imgResponse = await this.authFetch('/api/image/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: text }) });
        if (imgResponse.ok) {
          const imgData = await imgResponse.json() as { url: string; thumbnailUrl: string };
          this.inlineAiImageUrl.set(imgData.url);
        } else {
          this.inlineAiResponse.set('Error: image generation failed.');
        }
      } catch {
        this.inlineAiResponse.set('Error: could not connect to image generation service.');
      } finally {
        this.inlineAiGeneratingImage.set(false);
        this.inlineAiStreaming.set(false);
      }
      return;
    }

    let content: string;
    if (selectedText) {
      content = text ? `Selected text:\n"${selectedText}"\n\n${text}` : `Selected text:\n"${selectedText}"`;
    } else {
      content = this.inlineAiSurroundingText
        ? `The following is the text surrounding the cursor position (marked with [CURSOR]). Use it ONLY as context. Do NOT repeat any surrounding text — return ONLY the new content to insert.\n\nSurrounding text:\n"${this.inlineAiSurroundingText}"\n\nInstruction: ${text}`
        : text;
    }

    const apiMessages = [{ role: 'user' as const, content }];
    this.inlineAiAbortController = new AbortController();

    const endpoint = this.aiEndpoint() || '/api/chat/general';
    const isGeneral = !this.aiEndpoint() || this.aiEndpoint() === '/api/chat/general';
    const bodyPayload = isGeneral
      ? JSON.stringify({ messages: apiMessages, seriesId: this.seriesId(), selectedText: selectedText || undefined })
      : JSON.stringify({ messages: apiMessages, selectedText: selectedText || undefined });

    try {
      const response = await this.authFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyPayload,
        signal: this.inlineAiAbortController.signal,
      });

      if (!response.ok || !response.body) { this.inlineAiResponse.set('Error: failed to get a response.'); return; }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as { content?: string; error?: string };
            if (parsed.error) this.inlineAiResponse.set(`Error: ${parsed.error}`);
            else if (parsed.content) this.inlineAiResponse.update(r => r + parsed.content);
          } catch { /* skip */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') this.inlineAiResponse.set('Error: could not connect to AI.');
    } finally {
      this.inlineAiStreaming.set(false);
      this.inlineAiAbortController = null;
      setTimeout(() => this.inlineAiInputEl?.nativeElement?.focus());
    }
  }

  acceptInlineAiResponse(): void {
    const imageUrl = this.inlineAiImageUrl();
    if (imageUrl) {
      if (!this.inlineAiCursorRange) return;
      const range = this.inlineAiCursorRange;
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      range.deleteContents();
      const img = document.createElement('img');
      img.src = this.proxyUrl(imageUrl) ?? imageUrl;
      img.style.maxWidth = '100%';
      range.insertNode(img);
      const ar = document.createRange();
      ar.setStartAfter(img);
      ar.collapse(true);
      if (sel) { sel.removeAllRanges(); sel.addRange(ar); }
      this.scrollCursorIntoView();
      if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
      this.dismissInlineAiPrompt(false);
      return;
    }

    let text = this.inlineAiResponse();
    if (!text || !this.inlineAiCursorRange) return;

    const QUOTE_CHARS = new Set(['"', "'", '\u201C', '\u201D', '\u2018', '\u2019']);
    if (QUOTE_CHARS.has(this.inlineAiCharBefore) && QUOTE_CHARS.has(text[0])) text = text.slice(1);
    if (QUOTE_CHARS.has(this.inlineAiCharAfter) && text.length > 0 && QUOTE_CHARS.has(text[text.length - 1])) text = text.slice(0, -1);

    const range = this.inlineAiCursorRange;
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    range.deleteContents();
    const fragment = this.buildEntityAnnotatedFragment(text);
    const wrapper = document.createElement('span');
    wrapper.setAttribute('data-ai-generated', 'true');
    wrapper.appendChild(fragment);
    range.insertNode(wrapper);
    const ar = document.createRange();
    ar.setStartAfter(wrapper);
    ar.collapse(true);
    if (sel) { sel.removeAllRanges(); sel.addRange(ar); }
    this.scrollCursorIntoView();
    if (this.editorRef) { this.editorContent = this.editorRef.nativeElement.innerHTML; this.scheduleEmit(); }
    this.dismissInlineAiPrompt(false);
  }

  dismissInlineAiPrompt(restoreFocus = true): void {
    this.removeAiMarker();
    this.inlineAiResizeObserver?.disconnect();
    this.inlineAiResizeObserver = null;
    this.inlineAiAnchorRect = null;
    this.inlineAiAbortController?.abort();
    this.inlineAiAbortController = null;
    this.inlineAiVisible.set(false);
    this.inlineAiInput.set('');
    this.inlineAiResponse.set('');
    this.inlineAiImageUrl.set(null);
    this.inlineAiGeneratingImage.set(false);
    this.inlineAiSelectedText.set('');
    if (restoreFocus && this.inlineAiCursorRange && this.editorRef) {
      const range = this.inlineAiCursorRange;
      this.editorRef.nativeElement.focus();
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }
    this.inlineAiCursorRange = null;
  }

  private insertAiMarker(): void {
    this.removeAiMarker();
    if (!this.inlineAiCursorRange || !this.editorRef) return;
    if (this.inlineAiSelectedText()) return;
    const marker = document.createElement('span');
    marker.className = 'ai-insertion-marker';
    marker.setAttribute('data-ai-marker', '');
    Object.assign(marker.style, { display: 'inline-block', width: '2px', height: '1.2em', verticalAlign: 'text-bottom', background: '#6750a4', borderRadius: '1px', pointerEvents: 'none', margin: '0 1px', animation: 'ai-marker-blink 1s step-end infinite' });
    const range = this.inlineAiCursorRange;
    range.insertNode(marker);
    const nr = document.createRange();
    nr.setStartAfter(marker);
    nr.collapse(true);
    this.inlineAiCursorRange = nr;
  }

  private removeAiMarker(): void {
    this.editorRef?.nativeElement.querySelectorAll('.ai-insertion-marker').forEach(el => el.remove());
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

    this.unwrapGrammarMarks();
    if (this.userSettings.grammarCheckEnabled() && errors.length > 0) this.applyGrammarMarks(errors);

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
    return 'full-name';
  }

  private getTextForReferenceType(entity: Entity, refType: EntityReference): string {
    const refs = this.resolvedRefs(entity);
    switch (refType) {
      case 'first-name': return refs.firstName || entity.name;
      case 'last-name': return refs.lastName || entity.name;
      case 'nickname': return refs.nickname || entity.name;
      case 'title-full-name': return refs.title ? `${refs.title} ${entity.name}` : entity.name;
      case 'title-last-name': return refs.title && refs.lastName ? `${refs.title} ${refs.lastName}` : entity.name;
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

  private isImageRequest(text: string): boolean {
    return /\b(generate|create|draw|make|produce|illustrate)\b[\s\S]{0,60}\b(image|picture|illustration|artwork|photo|painting)\b/i.test(text) ||
           /\b(image|draw|illustrate|paint)\s*:/i.test(text);
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

    // Collect block-level rows: direct children cover <div>/<p>/<h*>/etc.
    // Chrome contenteditable produces <div> on Enter; stored HTML may use <p> or <h*>.
    // For lists, expand the <ul>/<ol> into its <li> children.
    const rawChildren = Array.from(editor.children) as HTMLElement[];
    const blocks: HTMLElement[] = rawChildren.flatMap(child =>
      (child.tagName === 'UL' || child.tagName === 'OL')
        ? Array.from(child.children) as HTMLElement[]
        : [child],
    );

    for (const block of blocks) {
      const hasImg = !!block.querySelector('img');
      if (!block.textContent?.trim() && !hasImg) continue;

      const blockRect = block.getBoundingClientRect();
      const offsetTop = blockRect.top - editorRect.top + editor.scrollTop;
      const blockH = block.offsetHeight;
      if (blockH <= 0) continue;

      const yTop = offsetTop * scale;
      if (yTop > H) continue;
      const yH = blockH * scale;

      const isHeading = /^H[1-6]$/.test(block.tagName);
      const indent = isHeading ? 2 : 4;
      const maxLineW = W - indent * 2;
      const opacity = isHeading ? 0.78 : 0.55;
      ctx.fillStyle = `rgba(${tr},${tg},${tb},${opacity})`;

      if (hasImg) {
        ctx.fillStyle = `rgba(${tr},${tg},${tb},0.2)`;
        ctx.fillRect(indent, yTop, maxLineW, Math.max(2, yH));
      } else {
        // Use the browser's actual line layout via Range.getClientRects().
        // This gives exact Y positions and text widths for every wrapped line.
        const range = document.createRange();
        range.selectNodeContents(block);
        const rawRects = Array.from(range.getClientRects());

        // Merge rects that share the same visual line (within 2 px tolerance).
        const lineGroups: { top: number; minLeft: number; maxRight: number; height: number }[] = [];
        for (const r of rawRects) {
          if (r.width < 1 || r.height < 1) continue;
          const existing = lineGroups.find(l => Math.abs(l.top - r.top) < 2);
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
        const wsWalker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let wsNode: Text | null;
        wsLoop: while ((wsNode = wsWalker.nextNode() as Text | null)) {
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
          const miniH = Math.max(1, line.height * scale - 0.5);

          ctx.fillRect(lineX, miniY, lineW, miniH);
        }
      }
    }

    // Fallback: editor has raw text not wrapped in any child elements
    if (blocks.length === 0 && editor.textContent?.trim()) {
      const lineH = parseFloat(getComputedStyle(editor).lineHeight) || 20;
      const numLines = Math.round(totalH / lineH);
      const miniLineH = Math.max(1, lineH * scale);
      ctx.fillStyle = `rgba(${tr},${tg},${tb},0.5)`;
      for (let i = 0; i < numLines; i++) {
        const lineY = i * miniLineH;
        if (lineY > H) break;
        ctx.fillRect(4, lineY, W - 12, Math.max(1, miniLineH - 0.5));
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

  private authFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const token = localStorage.getItem('app_auth_token');
    const headers = new Headers(init.headers as HeadersInit);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  }
}
