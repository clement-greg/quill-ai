import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Injector, OnDestroy,
  afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild, viewChildren,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RichTextEditorComponent, SuggestedEntityCard } from '@app/shared/rich-text-editor/rich-text-editor';
import { Entity } from '@shared/models/entity.model';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import {
  PAGE_GAP, PAGE_HEIGHT, PAGE_STRIDE, PAGE_WIDTH, estimatePageCount, indexAt, pageOffsets, sectionHeight,
} from './book-layout';
import { measureChapterPages, paginateChapter, removePageSpacers } from './book-paginator';

/** A chapter as the book editor shows it. `content` is the latest known HTML
 *  (saved or draft); it is only read when the chapter's editor mounts. */
export interface BookChapter {
  id: string;
  title: string;
  content: string;
}

export interface ChapterSplitEvent {
  sourceId: string;
  /** Title for the new chapter (from "# Title", or a default for Ctrl+Enter). */
  title: string;
  /** HTML moved out of the source chapter into the new one. */
  html: string;
  /** Whether the new chapter should get focus on its title (Ctrl+Enter) or body. */
  focus: 'title' | 'body';
}

export interface BookPagePosition {
  page: number;
  totalPages: number;
  chapterIndex: number;
  chapterTitle: string;
}

/** Padding above the first page inside the scroller. */
const COLUMN_PAD = 32;
/** Room under the last page for the "New chapter" button. */
const END_SPACE = 120;
/** How far beyond the viewport chapters stay mounted (px). */
const MOUNT_MARGIN = 1600;
/** Default characters per page before anything has been measured. */
const DEFAULT_CHARS_PER_PAGE = 2400;

/**
 * Full-book editor: every chapter of a book laid out as US Letter pages, one
 * live rich-text editor per chapter.
 *
 * Performance model:
 *  - Virtualised by chapter. Only chapters within MOUNT_MARGIN of the viewport
 *    (plus the active one) mount an editor; the rest are empty boxes sized to
 *    their page count, so a 400-page book costs a handful of editors.
 *  - Page counts for unmounted chapters are measured in idle time on a hidden
 *    copy of the flow, so heights (and book-wide page numbers) converge to
 *    exact without blocking typing. Until then they're estimated from text
 *    length, calibrated by what has been measured.
 *  - Height changes above the viewport are compensated in scrollTop so the
 *    text under the reader never jumps.
 *  - Pagination of the chapter being edited runs at most once per frame, in
 *    one read pass and one write pass.
 */
@Component({
  selector: 'app-book-editor',
  imports: [RichTextEditorComponent, DecimalPipe],
  templateUrl: './book-editor.html',
  styleUrl: './book-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookEditorComponent implements AfterViewInit, OnDestroy {
  private injector = inject(Injector);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private userSettings = inject(UserSettingsService);

  // ── Inputs ────────────────────────────────────────────────────────────────
  chapters = input.required<BookChapter[]>();
  activeChapterId = input<string | null>(null);
  seriesId = input<string>('');
  entities = input<Entity[] | null>(null);
  ctxMenuExtraItems = input<{ id: string; label: string; icon: string }[]>([]);
  /** Keep the sidebar on this chapter regardless of scrolling (e.g. while a
   *  review or fact check runs against it). */
  pinActive = input<boolean>(false);

  // ── Outputs ───────────────────────────────────────────────────────────────
  activeChapterChange = output<string>();
  chapterInput = output<string>();
  chapterContentChange = output<{ id: string; html: string }>();
  titleChange = output<{ id: string; title: string }>();
  splitChapter = output<ChapterSplitEvent>();
  mergeRequest = output<string>();
  /** "New chapter" button under the last page. */
  newChapterAtEnd = output<void>();
  /** Fires whenever a chapter's editor mounts (so the host can re-bind to it). */
  editorMounted = output<string>();

  // Pass-throughs from the active chapter's editor.
  entityEditRequest = output<Entity>();
  pendingSuggestionsChange = output<SuggestedEntityCard[]>();
  ctxMenuExtraItemSelected = output<{ id: string; captureText: string; narratorCaptureText: string; surroundingText: string }>();
  aiAssistRequested = output<void>();
  reviewSuggestionHovered = output<string | null>();
  reviewSuggestionAction = output<{ id: string; action: 'accept' | 'reject' }>();
  noteRequest = output<void>();
  moveTextRequest = output<{ text: string }>();

  // ── View refs ─────────────────────────────────────────────────────────────
  private scroller = viewChild.required<ElementRef<HTMLDivElement>>('scroller');
  private minimapCanvas = viewChild<ElementRef<HTMLCanvasElement>>('minimapCanvas');
  private measureFlow = viewChild.required<ElementRef<HTMLDivElement>>('measureFlow');
  private measureSection = viewChild.required<ElementRef<HTMLDivElement>>('measureSection');
  private editors = viewChildren(RichTextEditorComponent);

  readonly PAGE_WIDTH = PAGE_WIDTH;
  readonly PAGE_HEIGHT = PAGE_HEIGHT;
  readonly PAGE_STRIDE = PAGE_STRIDE;
  readonly COLUMN_PAD = COLUMN_PAD;
  readonly Math = Math;

  // ── Layout state ──────────────────────────────────────────────────────────
  /** Exact page counts, from live pagination or idle measurement. */
  private measuredPages = signal<ReadonlyMap<string, number>>(new Map());
  /** Content signature each measurement was taken against. */
  private measuredKey = new Map<string, string>();
  /** Chapters within the mount window. */
  private nearIds = signal<ReadonlySet<string>>(new Set());

  private charsPerPage = computed(() => {
    const measured = this.measuredPages();
    let chars = 0;
    let pages = 0;
    for (const ch of this.chapters()) {
      const n = measured.get(ch.id);
      if (n && n > 1) { chars += this.textLength(ch); pages += n - 0.5; }
    }
    return pages > 0 ? chars / pages : DEFAULT_CHARS_PER_PAGE;
  });

  readonly pageCounts = computed(() => {
    const measured = this.measuredPages();
    const cpp = this.charsPerPage();
    return this.chapters().map(ch => measured.get(ch.id) ?? estimatePageCount(this.textLength(ch), cpp));
  });
  readonly heights = computed(() => this.pageCounts().map(sectionHeight));
  /** Top of each chapter section within the scroller's content. */
  readonly tops = computed(() => {
    const tops: number[] = [];
    let y = COLUMN_PAD;
    for (const h of this.heights()) { tops.push(y); y += h + PAGE_GAP; }
    return tops;
  });
  readonly offsets = computed(() => pageOffsets(this.pageCounts()));
  readonly totalHeight = computed(() => {
    const tops = this.tops();
    const heights = this.heights();
    const n = tops.length;
    return n ? tops[n - 1]! + heights[n - 1]! + END_SPACE : COLUMN_PAD * 2;
  });
  /** Where the "New chapter" button sits (just under the last page). */
  readonly endButtonTop = computed(() => this.totalHeight() - END_SPACE + 32);

  /** Shortcut label for the platform (⌘ on Apple, Ctrl elsewhere). */
  readonly modKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

  /** Inline hint on an empty line (or a "# Title" line) explaining how to
   *  start a new chapter; positioned in the column's coordinates. */
  readonly chapterHint = signal<{ top: number; left: number; text: string } | null>(null);

  readonly mountedIds = computed(() => {
    const ids = new Set(this.nearIds());
    const active = this.activeChapterId();
    if (active) ids.add(active);
    return ids;
  });

  /** Page indices [0..n) for each mounted chapter's sheets. */
  pagesFor(index: number): number[] {
    const n = this.pageCounts()[index] ?? 1;
    return Array.from({ length: n }, (_, i) => i);
  }

  // ── Minimap ───────────────────────────────────────────────────────────────
  readonly minimapPopup = signal<(BookPagePosition & { y: number }) | null>(null);
  readonly viewport = signal({ top: 0, height: 0, clientHeight: 0 });
  private minimapDragging = false;
  readonly minimapScale = computed(() => {
    const h = this.viewport().clientHeight;
    const total = this.totalHeight();
    return total > 0 && h > 0 ? Math.min(0.25, h / total) : 0;
  });

  // ── Internals ─────────────────────────────────────────────────────────────
  private intersection?: IntersectionObserver;
  private observedSections = new WeakSet<Element>();
  private mutationObservers = new Map<string, { mo: MutationObserver; el: HTMLElement }>();
  private pendingPaginate = new Set<string>();
  private paginateFrame: number | null = null;
  private scrollFrame: number | null = null;
  private idleHandle: number | null = null;
  private composing = false;
  private lastEmittedActive: string | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFocus: { id: string; target: 'title' | 'body' } | null = null;
  private resizeObserver?: ResizeObserver;
  private destroyed = false;

  constructor() {
    // Hook up pagination for each editor as it mounts.
    effect(() => {
      const editors = this.editors();
      untracked(() => this.syncEditors(editors));
    });

    // Font changes re-flow everything: drop measurements and re-paginate.
    effect(() => {
      this.userSettings.editorFontSize();
      this.userSettings.editorFontFamily();
      untracked(() => {
        this.measuredKey.clear();
        this.measuredPages.set(new Map());
        // Let the new CSS variables apply before measuring.
        setTimeout(() => {
          for (const id of this.mutationObservers.keys()) this.schedulePaginate(id);
          this.scheduleIdleMeasure();
        }, 50);
      });
    });

    // New/removed chapters: observe sections, schedule measurement, redraw minimap.
    effect(() => {
      this.chapters();
      untracked(() => {
        afterNextRender({ write: () => { this.observeSections(); this.scheduleIdleMeasure(); } }, { injector: this.injector });
      });
    });

    // Layout moved: put the reader back where they were.
    effect(() => {
      this.tops();
      untracked(() => afterNextRender({ write: () => this.restoreAnchor() }, { injector: this.injector }));
    });

    effect(() => {
      this.tops();
      this.viewport();
      this.minimapScale();
      untracked(() => this.renderMinimap());
    });
  }

  ngAfterViewInit(): void {
    const scroller = this.scroller().nativeElement;
    this.intersection = new IntersectionObserver(entries => this.onIntersect(entries), {
      root: scroller,
      rootMargin: `${MOUNT_MARGIN}px 0px`,
    });
    this.observeSections();
    this.resizeObserver = new ResizeObserver(() => this.updateViewport());
    this.resizeObserver.observe(scroller);
    this.updateViewport();
    document.addEventListener('selectionchange', this.onSelectionChange);
    // Delegated from the scroller so one set of listeners covers every chapter;
    // keydown runs in the capture phase to act before the editor's own handler.
    scroller.addEventListener('keydown', this.onKeyDownCapture, true);
    scroller.addEventListener('focusin', this.onFocusInEvent);
    scroller.addEventListener('input', this.onInputEvent);
    scroller.addEventListener('compositionstart', this.onCompositionStartEvent);
    scroller.addEventListener('compositionend', this.onCompositionEndEvent);
    this.scheduleIdleMeasure();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.flushAll();
    this.intersection?.disconnect();
    this.resizeObserver?.disconnect();
    for (const { mo } of this.mutationObservers.values()) mo.disconnect();
    this.mutationObservers.clear();
    if (this.paginateFrame !== null) cancelAnimationFrame(this.paginateFrame);
    if (this.scrollFrame !== null) cancelAnimationFrame(this.scrollFrame);
    if (this.idleHandle !== null) cancelIdle(this.idleHandle);
    if (this.activeTimer) clearTimeout(this.activeTimer);
    document.removeEventListener('selectionchange', this.onSelectionChange);
    const scroller = this.scroller().nativeElement;
    scroller.removeEventListener('keydown', this.onKeyDownCapture, true);
    scroller.removeEventListener('focusin', this.onFocusInEvent);
    scroller.removeEventListener('input', this.onInputEvent);
    scroller.removeEventListener('compositionstart', this.onCompositionStartEvent);
    scroller.removeEventListener('compositionend', this.onCompositionEndEvent);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** The mounted editor for a chapter, if any. */
  editorFor(id: string | null | undefined): RichTextEditorComponent | undefined {
    if (!id) return undefined;
    return this.editors().find(e => this.chapterIdOf(e) === id);
  }

  /** Every mounted chapter editor (e.g. to clear find highlights everywhere). */
  mountedEditors(): readonly RichTextEditorComponent[] {
    return this.editors();
  }

  /** Scrolls so the chapter's first page is at the top of the view. */
  scrollToChapter(id: string, behavior: ScrollBehavior = 'auto'): void {
    const i = this.indexOf(id);
    if (i < 0) return;
    const top = Math.max(0, this.tops()[i]! - 16);
    this.anchor = { id, offset: top - this.tops()[i]! };
    // The host chose this chapter: don't let the caret (still in the chapter
    // we're leaving) or a mid-animation viewport pull the sidebar back.
    this.navigationHoldUntil = performance.now() + (behavior === 'smooth' ? 1200 : 400);
    this.lastEmittedActive = id;
    this.scroller().nativeElement.scrollTo({ top, behavior });
  }

  /** Focuses a chapter's title or body start once its editor is mounted. */
  focusChapter(id: string, target: 'title' | 'body'): void {
    this.pendingFocus = { id, target };
    this.scrollToChapter(id);
    this.tryPendingFocus();
  }

  /** Replaces a chapter's content in its live editor (external changes). */
  setChapterContent(id: string, html: string): void {
    const editor = this.editorFor(id);
    if (!editor) return;
    editor.setContent(html);
    this.schedulePaginate(id);
  }

  /** Reads every mounted editor's content back to the host (before saving). */
  flushAll(): void {
    for (const editor of this.editors()) {
      const id = this.chapterIdOf(editor);
      if (id) this.chapterContentChange.emit({ id, html: editor.getContent() });
    }
  }

  /** Book page at a scroll offset (content coordinates). */
  positionAt(y: number): BookPagePosition | null {
    const chapters = this.chapters();
    if (!chapters.length) return null;
    const i = indexAt(this.tops(), y);
    const pages = this.pageCounts()[i] ?? 1;
    const within = Math.min(pages - 1, Math.max(0, Math.floor((y - this.tops()[i]!) / PAGE_STRIDE)));
    const { starts, total } = this.offsets();
    return {
      page: starts[i]! + within + 1,
      totalPages: total,
      chapterIndex: i,
      chapterTitle: chapters[i]!.title || 'Untitled chapter',
    };
  }

  // ── Template handlers ─────────────────────────────────────────────────────

  onScroll(): void {
    // Record the reader's place right away, not on the next frame: a layout
    // change in the same frame (e.g. a new page while typing) restores the
    // anchor, and a stale one would undo the browser's caret-into-view scroll.
    this.captureAnchor();
    if (this.scrollFrame !== null) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.updateViewport();
      this.updateActiveChapter(false);
    });
  }

  onTitleInput(id: string, value: string): void {
    this.titleChange.emit({ id, title: value });
  }

  onTitleKeyDown(id: string, event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.focusBodyStart(id);
    }
  }

  private readonly onFocusInEvent = (event: FocusEvent): void => {
    const id = chapterIdFromEvent(event);
    // Typing must always go to the chapter the sidebar shows: switch at once.
    if (id) this.emitActive(id, true);
  };

  private readonly onInputEvent = (event: Event): void => {
    const target = event.target as Element | null;
    if (!target?.classList?.contains('rte-content-editor')) return;
    const id = chapterIdFromEvent(event);
    if (id) this.chapterInput.emit(id);
    // Re-evaluate after this frame's pagination has moved things.
    requestAnimationFrame(() => requestAnimationFrame(() => this.updateChapterHint()));
  };

  private readonly onCompositionStartEvent = (): void => { this.composing = true; };
  private readonly onCompositionEndEvent = (event: Event): void => {
    this.composing = false;
    const id = chapterIdFromEvent(event);
    if (id) this.schedulePaginate(id);
  };

  private readonly onKeyDownCapture = (event: KeyboardEvent): void => {
    const target = event.target as Element | null;
    if (!target?.classList?.contains('rte-content-editor')) return;
    const id = chapterIdFromEvent(event);
    if (id) this.onEditorKeyDown(id, event);
  };

  /** Keyboard handling that has to beat the editor's own (capture phase). */
  private onEditorKeyDown(id: string, event: KeyboardEvent): void {
    if (event.isComposing || this.composing) return;
    const editorEl = this.editorFor(id)?.getEditorElement();
    if (!editorEl) return;

    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        this.splitAtCaret(id, editorEl);
        return;
      }
      if (this.trySplitAtHeading(id, editorEl)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }

    if (event.key === 'Backspace' && this.caretAtChapterStart(editorEl)) {
      event.preventDefault();
      event.stopPropagation();
      if (this.indexOf(id) > 0) this.mergeRequest.emit(id);
      return;
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      // A spacer sits beside the caret at every page break; let the key act on
      // the text, not the spacer. Spacers come back on the next frame.
      if (removePageSpacers(editorEl)) this.schedulePaginate(id);
    }
  }

  // Pass-through handlers (only the active chapter's editor reports out).
  onPendingSuggestions(id: string, cards: SuggestedEntityCard[]): void {
    if (id === this.activeChapterId()) this.pendingSuggestionsChange.emit(cards);
  }

  // ── Minimap ───────────────────────────────────────────────────────────────

  onMinimapMouseDown(event: MouseEvent): void {
    event.preventDefault();
    this.minimapDragging = true;
    this.scrubTo(event);
    const move = (e: MouseEvent) => this.scrubTo(e);
    const up = () => {
      this.minimapDragging = false;
      this.minimapPopup.set(null);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  onMinimapHover(event: MouseEvent): void {
    if (this.minimapDragging) return;
    const y = this.minimapContentY(event);
    const pos = this.positionAt(y);
    this.minimapPopup.set(pos ? { ...pos, y: this.minimapLocalY(event) } : null);
  }

  onMinimapLeave(): void {
    if (!this.minimapDragging) this.minimapPopup.set(null);
  }

  onMinimapWheel(event: WheelEvent): void {
    event.preventDefault();
    this.scroller().nativeElement.scrollTop += event.deltaY;
  }

  onMinimapKeyDown(event: KeyboardEvent): void {
    const scroller = this.scroller().nativeElement;
    const step = event.shiftKey ? PAGE_STRIDE * 10 : PAGE_STRIDE;
    if (event.key === 'ArrowDown' || event.key === 'PageDown') scroller.scrollTop += step;
    else if (event.key === 'ArrowUp' || event.key === 'PageUp') scroller.scrollTop -= step;
    else if (event.key === 'Home') scroller.scrollTop = 0;
    else if (event.key === 'End') scroller.scrollTop = scroller.scrollHeight;
    else return;
    event.preventDefault();
  }

  readonly currentPosition = computed(() => {
    const v = this.viewport();
    return this.positionAt(v.top + v.clientHeight / 3);
  });

  /** Word count of the chapter under the reading line: live from its editor
   *  when mounted, otherwise counted from the chapter's saved/draft HTML. */
  readonly currentChapterWords = computed(() => {
    const pos = this.currentPosition();
    const ch = pos ? this.chapters()[pos.chapterIndex] : undefined;
    if (!ch) return null;
    const editor = this.editorFor(ch.id);
    return editor ? editor.wordCount() : this.wordCountOf(ch);
  });

  private scrubTo(event: MouseEvent): void {
    const y = this.minimapContentY(event);
    const scroller = this.scroller().nativeElement;
    scroller.scrollTop = y - scroller.clientHeight / 2;
    this.captureAnchor();
    const pos = this.positionAt(y);
    this.minimapPopup.set(pos ? { ...pos, y: this.minimapLocalY(event) } : null);
  }

  private minimapLocalY(event: MouseEvent): number {
    const canvas = this.minimapCanvas()?.nativeElement;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  }

  private minimapContentY(event: MouseEvent): number {
    const scale = this.minimapScale();
    return scale > 0 ? this.minimapLocalY(event) / scale : 0;
  }

  private renderMinimap(): void {
    const canvas = this.minimapCanvas()?.nativeElement;
    if (!canvas) return;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const paper = this.resolveColor('--book-paper', '#fff');
    const edge = this.resolveColor('--book-page-edge', 'rgba(0,0,0,.25)');
    const accent = this.resolveColor('--book-accent', '#1976d2');
    const ink = this.resolveColor('--book-minimap-ink', '#666');

    const scale = this.minimapScale();
    const tops = this.tops();
    const counts = this.pageCounts();
    const chapters = this.chapters();
    const pageW = Math.min(cssW - 16, PAGE_WIDTH * 0.08);
    const x = 4;
    let lastLabelY = -Infinity;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textBaseline = 'top';

    for (let i = 0; i < chapters.length; i++) {
      const top = tops[i]!;
      for (let p = 0; p < counts[i]!; p++) {
        const y = (top + p * PAGE_STRIDE) * scale;
        const h = Math.max(1, PAGE_HEIGHT * scale);
        ctx.fillStyle = paper;
        ctx.fillRect(x, y, pageW, h);
        if (h >= 3) {
          ctx.strokeStyle = edge;
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x + 0.25, y + 0.25, pageW - 0.5, h - 0.5);
        }
      }
      const y = top * scale;
      ctx.fillStyle = accent;
      ctx.fillRect(x - 3, y, 2, Math.max(2, this.heights()[i]! * scale));
      if (y - lastLabelY >= 14) {
        ctx.fillStyle = ink;
        ctx.fillText(String(i + 1), x + pageW + 4, y);
        lastLabelY = y;
      }
    }
  }

  /** Theme colours can be `light-dark()`/`color-mix()` expressions, which a
   *  canvas can't parse; let the browser resolve them to rgb() first. */
  private colorProbe?: HTMLElement;
  private resolveColor(variable: string, fallback: string): string {
    if (!this.colorProbe) {
      this.colorProbe = document.createElement('span');
      this.colorProbe.style.display = 'none';
      this.host.nativeElement.appendChild(this.colorProbe);
    }
    this.colorProbe.style.color = `var(${variable}, ${fallback})`;
    return getComputedStyle(this.colorProbe).color || fallback;
  }

  // ── Viewport / active chapter ─────────────────────────────────────────────

  private updateViewport(): void {
    const s = this.scroller().nativeElement;
    this.viewport.set({ top: s.scrollTop, height: s.clientHeight, clientHeight: s.clientHeight });
  }

  private readonly onSelectionChange = (): void => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!node || !this.host.nativeElement.contains(node)) {
      this.chapterHint.set(null);
      return;
    }
    this.updateActiveChapter(false);
    this.updateChapterHint();
  };

  /** Shows the new-chapter hint when the caret sits on an empty line, and a
   *  "press Enter" confirmation once the line reads "# Title". */
  private updateChapterHint(): void {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) { this.chapterHint.set(null); return; }
    const caret = sel.getRangeAt(0);
    const startEl = caret.startContainer.nodeType === Node.ELEMENT_NODE
      ? caret.startContainer as Element
      : caret.startContainer.parentElement;
    const editorEl = startEl?.closest<HTMLElement>('.rte-content-editor');
    if (!editorEl || !this.host.nativeElement.contains(editorEl)) { this.chapterHint.set(null); return; }
    // An empty chapter shows the editor's own "Start writing…" placeholder;
    // a new-chapter hint there would draw on top of it (and isn't useful).
    if (!editorEl.textContent?.trim() && !editorEl.querySelector('img')) { this.chapterHint.set(null); return; }
    const line = this.currentLine(editorEl, caret);
    const text = (line?.text ?? editorEl.textContent ?? '').replace(/\u00a0/g, ' ');
    const heading = /^#{1,6}\s+(\S.*)$/.exec(text.trim());
    let hint: string | null = null;
    if (!text.trim()) hint = `Type # and a title, then Enter, to start a new chapter · ${this.modKey}+Enter splits here`;
    else if (heading) hint = `Enter ↵ starts a new chapter: "${heading[1]!.trim()}"`;
    else if (/^#{1,6}$/.test(text.trim())) hint = 'Add a space and the chapter title, then press Enter';
    if (!hint) { this.chapterHint.set(null); return; }

    // Anchor to the line's box (or the empty editor) in column coordinates.
    const anchorEl = line && line.first.nodeType === Node.ELEMENT_NODE ? line.first as Element : editorEl;
    let rect = caret.getBoundingClientRect();
    if (!rect.height) rect = anchorEl.getBoundingClientRect();
    const column = this.scroller().nativeElement.querySelector('.book-column');
    if (!column) return;
    const col = column.getBoundingClientRect();
    const flowLeft = editorEl.getBoundingClientRect().left - col.left;
    // An empty line shows the hint in place; a typed "# Title" shows it underneath.
    const top = (text.trim() ? rect.bottom : rect.top) - col.top;
    this.chapterHint.set({ top, left: flowLeft, text: hint });
  }

  private navigationHoldUntil = 0;

  private updateActiveChapter(immediate: boolean): void {
    if (this.pinActive() || performance.now() < this.navigationHoldUntil) return;
    const chapters = this.chapters();
    if (!chapters.length) return;
    const s = this.scroller().nativeElement;
    const viewTop = s.scrollTop;
    const viewBottom = viewTop + s.clientHeight;

    // The chapter holding the caret wins while it is on screen.
    const caretId = this.caretChapterId();
    if (caretId) {
      const i = this.indexOf(caretId);
      const top = this.tops()[i]!;
      if (top < viewBottom && top + this.heights()[i]! > viewTop) {
        this.emitActive(caretId, immediate);
        return;
      }
    }
    // Otherwise, the chapter under the reading line a third of the way down.
    const i = indexAt(this.tops(), viewTop + s.clientHeight / 3);
    this.emitActive(chapters[i]!.id, immediate);
  }

  private emitActive(id: string, immediate: boolean): void {
    if (this.pinActive() && id !== this.activeChapterId()) return;
    if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
    if (id === this.lastEmittedActive && id === this.activeChapterId()) return;
    const fire = () => {
      this.activeTimer = null;
      this.lastEmittedActive = id;
      if (id !== this.activeChapterId()) this.activeChapterChange.emit(id);
    };
    if (immediate) fire();
    else this.activeTimer = setTimeout(fire, 150);
  }

  private caretChapterId(): string | null {
    const node = window.getSelection()?.anchorNode;
    if (!node || !this.host.nativeElement.contains(node)) return null;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return el?.closest('[data-chapter-id]')?.getAttribute('data-chapter-id') ?? null;
  }

  // ── Virtualisation ────────────────────────────────────────────────────────

  private observeSections(): void {
    if (!this.intersection) return;
    const sections = this.scroller().nativeElement.querySelectorAll<HTMLElement>('section[data-chapter-id]');
    sections.forEach(s => {
      if (!this.observedSections.has(s)) {
        this.observedSections.add(s);
        this.intersection!.observe(s);
      }
    });
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    const next = new Set(this.nearIds());
    let changed = false;
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).dataset['chapterId'];
      if (!id) continue;
      if (entry.isIntersecting && !next.has(id)) { next.add(id); changed = true; }
      else if (!entry.isIntersecting && next.has(id)) {
        // Hand the latest text back before the editor is torn down.
        const editor = this.editorFor(id);
        if (editor) this.chapterContentChange.emit({ id, html: editor.getContent() });
        next.delete(id);
        changed = true;
      }
    }
    // Drop ids of chapters that no longer exist.
    const live = new Set(this.chapters().map(c => c.id));
    for (const id of next) if (!live.has(id)) { next.delete(id); changed = true; }
    if (changed) this.nearIds.set(next);
  }

  // ── Pagination ────────────────────────────────────────────────────────────

  private syncEditors(editors: readonly RichTextEditorComponent[]): void {
    const seen = new Set<string>();
    for (const editor of editors) {
      const id = this.chapterIdOf(editor);
      const el = editor.getEditorElement();
      if (!id || !el) continue;
      seen.add(id);
      const existing = this.mutationObservers.get(id);
      if (existing?.el === el) continue;
      existing?.mo.disconnect();
      const mo = new MutationObserver(() => this.schedulePaginate(id));
      mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'width', 'height'] });
      this.mutationObservers.set(id, { mo, el });
      this.schedulePaginate(id);
      this.editorMounted.emit(id);
    }
    for (const [id, { mo }] of this.mutationObservers) {
      if (!seen.has(id)) { mo.disconnect(); this.mutationObservers.delete(id); }
    }
    this.tryPendingFocus();
  }

  private schedulePaginate(id: string): void {
    this.pendingPaginate.add(id);
    if (this.paginateFrame !== null) return;
    this.paginateFrame = requestAnimationFrame(() => {
      this.paginateFrame = null;
      if (this.composing || this.destroyed) return;
      const ids = [...this.pendingPaginate];
      this.pendingPaginate.clear();
      for (const cid of ids) this.paginateNow(cid);
    });
  }

  private paginateNow(id: string): void {
    const entry = this.mutationObservers.get(id);
    if (!entry || !entry.el.isConnected) return;
    const section = entry.el.closest<HTMLElement>('section[data-chapter-id]');
    if (!section) return;
    const { pageCount } = paginateChapter(entry.el, section);
    entry.mo.takeRecords(); // our own spacer edits aren't user changes
    const ch = this.chapters().find(c => c.id === id);
    if (ch) this.measuredKey.set(id, this.measureKey(ch));
    this.setMeasured(id, pageCount);
  }

  /** Records a chapter's page count. (The scroll anchor keeps the reader's
   *  place when this moves chapters around.) */
  private setMeasured(id: string, pages: number): void {
    const current = this.measuredPages();
    if (current.get(id) === pages) return;
    const next = new Map(current);
    next.set(id, pages);
    this.measuredPages.set(next);
  }

  /** The reader's place: a chapter and how far into it the viewport top is.
   *  Measuring changes heights everywhere (including estimates, as the
   *  chars-per-page calibration improves), so after any layout change the
   *  scroll position is re-derived from this rather than patched by deltas. */
  private anchor: { id: string; offset: number } | null = null;

  private captureAnchor(): void {
    const chapters = this.chapters();
    if (!chapters.length) return;
    const top = this.scroller().nativeElement.scrollTop;
    // Look just past the inter-page gap so a view parked a few px above a
    // chapter's first page anchors to that chapter, not the one before it.
    const i = indexAt(this.tops(), top + PAGE_GAP + 1);
    this.anchor = { id: chapters[i]!.id, offset: top - this.tops()[i]! };
  }

  private restoreAnchor(): void {
    const a = this.anchor;
    if (!a) return;
    const i = this.indexOf(a.id);
    if (i < 0) return;
    const scroller = this.scroller().nativeElement;
    const offset = Math.min(a.offset, this.heights()[i]!);
    const target = this.tops()[i]! + offset;
    if (Math.abs(scroller.scrollTop - target) > 1) scroller.scrollTop = target;
  }

  // ── Idle measurement of unmounted chapters ────────────────────────────────

  private scheduleIdleMeasure(): void {
    if (this.idleHandle !== null || this.destroyed) return;
    this.idleHandle = requestIdle(deadline => {
      this.idleHandle = null;
      this.measureInIdle(deadline);
    });
  }

  private measureInIdle(deadline: IdleDeadline): void {
    const chapters = this.chapters();
    const mounted = this.mountedIds();
    const order = this.measureOrder();
    let measuredThisSlice = 0;
    for (const i of order) {
      if (deadline.didTimeout ? measuredThisSlice >= 2 : deadline.timeRemaining() < 6) break;
      const ch = chapters[i]!;
      if (mounted.has(ch.id)) continue; // live pagination owns mounted chapters
      const key = this.measureKey(ch);
      if (this.measuredKey.get(ch.id) === key) continue;
      const flow = this.measureFlow().nativeElement;
      flow.innerHTML = ch.content || '';
      const pages = measureChapterPages(flow, this.measureSection().nativeElement);
      flow.innerHTML = '';
      this.measuredKey.set(ch.id, key);
      this.setMeasured(ch.id, pages);
      measuredThisSlice++;
    }
    const remaining = order.some(i => {
      const ch = chapters[i]!;
      return !mounted.has(ch.id) && this.measuredKey.get(ch.id) !== this.measureKey(ch);
    });
    if (remaining) this.scheduleIdleMeasure();
  }

  /** Chapters nearest the viewport first, so what the reader is about to see settles first. */
  private measureOrder(): number[] {
    const n = this.chapters().length;
    const s = this.scroller().nativeElement;
    const centre = indexAt(this.tops(), s.scrollTop + s.clientHeight / 2);
    const order: number[] = [];
    for (let d = 0; order.length < n; d++) {
      if (centre + d < n) order.push(centre + d);
      if (d > 0 && centre - d >= 0) order.push(centre - d);
      if (centre + d >= n && centre - d < 0) break;
    }
    return order;
  }

  private measureKey(ch: BookChapter): string {
    return `${ch.content.length}:${this.userSettings.editorFontSize()}:${this.userSettings.editorFontFamily()}:${ch.title}`;
  }

  // ── Chapter split / merge ─────────────────────────────────────────────────

  /** "# Title" + Enter: the heading line becomes a new chapter's title and
   *  everything after it moves into that chapter. */
  private trySplitAtHeading(id: string, editorEl: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
    const caret = sel.getRangeAt(0);
    if (!editorEl.contains(caret.startContainer)) return false;

    const line = this.currentLine(editorEl, caret);
    if (!line) return false;
    const text = line.text.replace(/ /g, ' ');
    const match = /^#{1,6}\s+(\S.*)$/.exec(text.trim());
    if (!match) return false;
    // Only when the caret is at the end of the heading line.
    const after = document.createRange();
    after.setStart(caret.endContainer, caret.endOffset);
    after.setEndAfter(line.last);
    if (after.toString().trim() !== '') return false;

    const tail = document.createRange();
    tail.setStartAfter(line.last);
    tail.setEnd(editorEl, editorEl.childNodes.length);
    const html = this.extractHtml(tail);
    // Remove the heading line itself (and a trailing <br> that ended it).
    const remove = document.createRange();
    remove.setStartBefore(line.first);
    remove.setEndAfter(line.last);
    remove.deleteContents();
    this.trimTrailingEmpty(editorEl);
    this.commitEdit(editorEl);
    this.chapterHint.set(null);
    this.splitChapter.emit({ sourceId: id, title: match[1]!.trim(), html, focus: 'body' });
    return true;
  }

  /** Ctrl/Cmd+Enter: everything after the caret becomes a new chapter. */
  private splitAtCaret(id: string, editorEl: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const caret = sel.getRangeAt(0);
    if (!editorEl.contains(caret.startContainer)) return;
    caret.deleteContents();
    const tail = document.createRange();
    tail.setStart(caret.startContainer, caret.startOffset);
    tail.setEnd(editorEl, editorEl.childNodes.length);
    const html = this.extractHtml(tail);
    this.trimTrailingEmpty(editorEl);
    this.commitEdit(editorEl);
    this.splitChapter.emit({ sourceId: id, title: 'New Chapter', html, focus: 'title' });
  }

  private extractHtml(range: Range): string {
    const frag = range.extractContents();
    const div = document.createElement('div');
    div.appendChild(frag);
    removePageSpacers(div);
    // An emptied leading block (the split point) adds nothing.
    while (div.firstChild && isEmptyNode(div.firstChild)) div.firstChild.remove();
    return div.innerHTML;
  }

  /** Removes empty blocks left at the end after a split (the remains of the
   *  paragraph the caret was in). */
  private trimTrailingEmpty(editorEl: HTMLElement): void {
    removePageSpacers(editorEl);
    while (editorEl.lastChild && isEmptyNode(editorEl.lastChild) && editorEl.childNodes.length > 1) {
      editorEl.lastChild.remove();
    }
  }

  /** Lets the editor pick up a structural change as if the author typed it. */
  private commitEdit(editorEl: HTMLElement): void {
    editorEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
  }

  /** The logical line (paragraph block, or a <br>-delimited run of loose text)
   *  containing the caret. */
  private currentLine(editorEl: HTMLElement, caret: Range): { first: Node; last: Node; text: string } | null {
    let node: Node | null = caret.startContainer;
    if (node === editorEl) node = editorEl.childNodes[Math.max(0, caret.startOffset - 1)] ?? null;
    if (!node) return null;
    // Climb to the editor's direct child.
    while (node.parentNode && node.parentNode !== editorEl) node = node.parentNode;
    if (node.parentNode !== editorEl) return null;
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).matches('div, p, h1, h2, h3, h4, h5, h6, blockquote')) {
      return { first: node, last: node, text: node.textContent ?? '' };
    }
    // Loose inline content: extend to the surrounding <br>s / blocks.
    let first: Node = node;
    while (first.previousSibling && !isLineBoundary(first.previousSibling)) first = first.previousSibling;
    let last: Node = node;
    while (last.nextSibling && !isLineBoundary(last.nextSibling)) last = last.nextSibling;
    if (last.nextSibling?.nodeName === 'BR') last = last.nextSibling;
    let text = '';
    for (let n: Node | null = first; n; n = n.nextSibling) {
      text += n.textContent ?? '';
      if (n === last) break;
    }
    return { first, last, text };
  }

  private caretAtChapterStart(editorEl: HTMLElement): boolean {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
    const caret = sel.getRangeAt(0);
    if (!editorEl.contains(caret.startContainer)) return false;
    const before = document.createRange();
    before.setStart(editorEl, 0);
    before.setEnd(caret.startContainer, caret.startOffset);
    if (before.toString().length > 0) return false;
    return !before.cloneContents().querySelector?.('img');
  }

  private focusBodyStart(id: string): void {
    const el = this.editorFor(id)?.getEditorElement();
    if (!el) return;
    el.focus();
    const range = document.createRange();
    range.setStart(el, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  private tryPendingFocus(): void {
    const pending = this.pendingFocus;
    if (!pending) return;
    const editor = this.editorFor(pending.id);
    if (!editor) return;
    this.pendingFocus = null;
    setTimeout(() => {
      if (pending.target === 'title') {
        const input = this.host.nativeElement.querySelector<HTMLInputElement>(
          `section[data-chapter-id="${pending.id}"] .chapter-title`);
        input?.focus();
        input?.select();
      } else {
        this.focusBodyStart(pending.id);
      }
      this.emitActive(pending.id, true);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private chapterIdOf(editor: RichTextEditorComponent): string | null {
    return editor.getEditorElement()?.closest('[data-chapter-id]')?.getAttribute('data-chapter-id') ?? null;
  }

  private indexOf(id: string): number {
    return this.chapters().findIndex(c => c.id === id);
  }

  private wordCounts = new WeakMap<BookChapter, number>();
  private wordCountOf(ch: BookChapter): number {
    let n = this.wordCounts.get(ch);
    if (n === undefined) {
      const text = (ch.content || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').trim();
      n = text ? text.split(/\s+/).length : 0;
      this.wordCounts.set(ch, n);
    }
    return n;
  }

  private textLengths = new WeakMap<BookChapter, number>();
  private textLength(ch: BookChapter): number {
    let n = this.textLengths.get(ch);
    if (n === undefined) {
      n = (ch.content || '').replace(/<[^>]*>/g, '').length;
      this.textLengths.set(ch, n);
    }
    return n;
  }
}

function chapterIdFromEvent(event: Event): string | null {
  const target = event.target as Element | null;
  return target?.closest?.('[data-chapter-id]')?.getAttribute('data-chapter-id') ?? null;
}

function isLineBoundary(n: Node): boolean {
  return n.nodeName === 'BR' || (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches('div, p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol'));
}

function isEmptyNode(n: Node): boolean {
  if (n.nodeType === Node.TEXT_NODE) return !(n as Text).data.replace(/ /g, ' ').trim();
  if (n.nodeType !== Node.ELEMENT_NODE) return true;
  const el = n as Element;
  if (el.querySelector('img')) return false;
  return !(el.textContent ?? '').replace(/ /g, ' ').trim();
}

type IdleCb = (deadline: IdleDeadline) => void;
function requestIdle(cb: IdleCb): number {
  if (typeof window.requestIdleCallback === 'function') return window.requestIdleCallback(cb, { timeout: 1500 });
  return window.setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 8 } as IdleDeadline), 50);
}
function cancelIdle(handle: number): void {
  if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
  else clearTimeout(handle);
}
