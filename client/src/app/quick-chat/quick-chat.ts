import {
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  ElementRef,
  NgZone,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDialog } from '@angular/material/dialog';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { firstValueFrom, forkJoin } from 'rxjs';
import { ChapterEditProposal, ChatMessageHighlight, ChatSessionMessage, EntityLinkGroup, EntityLinkSession, MapPreview } from '@shared/models';
import { Entity } from '@shared/models/entity.model';
import { QuickChatService } from '../services/quick-chat.service';
import { SpeechRecognitionService } from '../services/speech-recognition.service';
import { AiAssistantService } from '../services/ai-assistant.service';
import { EntityService } from '../services/entity.service';
import { BookService } from '../book/book.service';
import { ChapterService } from '../chapter/chapter.service';
import { EditorBridgeService } from '../services/editor-bridge.service';
import { UserSettingsService, GhostCompleteItem } from '../services/user-settings.service';
import { chatMarkdownToHtml, chapterIdFromClick } from '../shared/chat-markdown';
import { MapPreviewComponent } from '../maps/map-preview/map-preview';
import { EntityPickerDialogComponent, EntityPickerData } from '../entity-edit/entity-picker-dialog';
import { FolderLocationPickerDialogComponent, FolderLocation, FolderLocationPickerData } from '../ai-assistant/folder-location-picker-dialog';
import { QuillyCharacterComponent } from '../shared/quilly-character/quilly-character';

/** Intro Quilly speaks when the empty panel first appears. */
const QC_INTRO = "Ask me anything about your books. Or pick an action to get started '/'";
/** Follow-up Quilly speaks if the user is still idle after the intro. */
const QC_OPTIONS = 'Here are some options:';
/** How long to wait, with no user activity, before offering the action chips. */
const QC_OPTIONS_DELAY_MS = 10_000;

/** A single item in the entity/chapter/book autocomplete popup. */
type AcItem =
  | { kind: 'entity'; id: string; name: string; entityType: string }
  | { kind: 'chapter'; id: string; name: string }
  | { kind: 'book'; id: string; name: string };

/**
 * A discoverable agentic action surfaced via the `/` command menu (and the
 * empty-state chips). Selecting one either navigates directly (when `route` is
 * set) or seeds the composer with a guided prompt `scaffold` that flows through
 * the normal chat agent loop. The menu is purely a teaching/shortcut layer.
 */
interface SlashCommand {
  /** The word typed after `/` (e.g. "image"); also matched for filtering. */
  command: string;
  /** Extra terms that should match this command in the filter. */
  keywords: string[];
  icon: string;
  label: string;
  hint: string;
  /** When set, selecting this command navigates immediately — no LLM, no message. */
  route?: string;
  /** When set, runs a named in-component action immediately — no LLM, no message. */
  action?: 'new-chat' | 'open-resources' | 'minimize';
  /** Text inserted into the composer; ignored when `route` or `action` is set. */
  scaffold: string;
  /** Only offer this when the overlay was opened from a chapter editor. */
  requiresChapter?: boolean;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    command: 'hide',
    keywords: ['collapse', 'close', 'minimize', 'dismiss'],
    icon: 'minimize',
    label: 'Hide chat',
    hint: 'Collapse the Ask Quill panel',
    action: 'minimize',
    scaffold: '',
  },
  {
    command: 'new',
    keywords: ['clear', 'reset', 'fresh'],
    icon: 'add_comment',
    label: 'New chat',
    hint: 'Clear the conversation and start fresh',
    action: 'new-chat',
    scaffold: '',
  },
  {
    command: 'resources',
    keywords: ['files', 'manager', 'library', 'notes'],
    icon: 'folder_open',
    label: 'Resource Manager',
    hint: 'Open the Resource Manager panel',
    action: 'open-resources',
    scaffold: '',
  },
  {
    command: 'draft',
    keywords: ['write', 'chapter', 'prose'],
    icon: 'auto_stories',
    label: 'Draft this chapter',
    hint: 'Write a full first draft from your outline & notes',
    scaffold: 'Draft this chapter based on the outline and notes: ',
    requiresChapter: true,
  },
  {
    command: 'chapter',
    keywords: ['create', 'new'],
    icon: 'post_add',
    label: 'Create a chapter',
    hint: 'Create and open a new chapter',
    scaffold: 'Create a chapter called ',
  },
  {
    command: 'image',
    keywords: ['draw', 'picture', 'illustrate', 'art'],
    icon: 'image',
    label: 'Generate an image',
    hint: 'Create an illustration from a description',
    scaffold: 'Draw ',
  },
  {
    command: 'map',
    keywords: ['show'],
    icon: 'map',
    label: 'Show a map',
    hint: 'Display one of your maps inline',
    scaffold: 'Show me the map of ',
  },
  {
    command: 'note',
    keywords: ['add'],
    icon: 'sticky_note_2',
    label: 'Add a note',
    hint: 'Save a note to a book or chapter',
    scaffold: 'Add a note to ',
  },
  {
    command: 'edit',
    keywords: ['review', 'proofread', 'suggestions', 'quill editor'],
    icon: 'rate_review',
    label: 'Edit a chapter',
    hint: 'Run the Quill Editor on a chapter for AI suggestions',
    scaffold: 'Edit ',
  },
  {
    command: 'outline',
    keywords: ['add'],
    icon: 'format_list_bulleted',
    label: 'Add to an outline',
    hint: 'Add an item to a book or chapter outline',
    scaffold: 'Add to the outline of ',
  },
  {
    command: 'open',
    keywords: ['go', 'navigate', 'jump'],
    icon: 'open_in_new',
    label: 'Open something',
    hint: 'Jump to a chapter, book, series, or character',
    scaffold: 'Open ',
  },
  {
    command: 'home',
    keywords: ['dashboard', 'start'],
    icon: 'home',
    label: 'Home',
    hint: 'Go to the Home page',
    route: '/home',
    scaffold: '',
  },
  {
    command: 'series',
    keywords: ['books', 'library'],
    icon: 'collections_bookmark',
    label: 'Series',
    hint: 'Go to the Series list',
    route: '/series',
    scaffold: '',
  },
  {
    command: 'entities',
    keywords: ['characters', 'people', 'places', 'things'],
    icon: 'group',
    label: 'Entities',
    hint: 'Go to the Entities page',
    route: '/entities',
    scaffold: '',
  },
  {
    command: 'relationships',
    keywords: ['diagram', 'graph', 'connections'],
    icon: 'hub',
    label: 'Relationships',
    hint: 'Go to the Relationships diagram',
    route: '/relationships',
    scaffold: '',
  },
  {
    command: 'maps',
    keywords: ['map', 'world'],
    icon: 'map',
    label: 'Maps',
    hint: 'Go to the Maps page',
    route: '/maps',
    scaffold: '',
  },
  {
    command: 'gallery',
    keywords: ['photos', 'images', 'pictures'],
    icon: 'photo_library',
    label: 'Photo Gallery',
    hint: 'Go to the Photo Gallery',
    route: '/gallery',
    scaffold: '',
  },
  {
    command: 'stats',
    keywords: ['writing', 'words', 'progress'],
    icon: 'bar_chart',
    label: 'Writing Stats',
    hint: 'Go to Writing Stats',
    route: '/writing-stats',
    scaffold: '',
  },
  {
    command: 'archived',
    keywords: ['archive'],
    icon: 'inventory_2',
    label: 'Archived',
    hint: 'Go to Archived items',
    route: '/archived',
    scaffold: '',
  },
  {
    command: 'settings',
    keywords: ['preferences', 'account', 'profile'],
    icon: 'settings',
    label: 'Settings',
    hint: 'Go to Settings',
    route: '/settings',
    scaffold: '',
  },
];

/**
 * The quick-launch "Ask Quill" overlay (Ctrl/Cmd+I). A centered, spotlight-style
 * modal for asking questions answered with cross-series vector search. Ephemeral
 * by default — the Save action persists the conversation into the Resource Manager.
 */
@Component({
  selector: 'app-quick-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, MatProgressSpinnerModule, MapPreviewComponent, QuillyCharacterComponent],
  templateUrl: './quick-chat.html',
  styleUrl: './quick-chat.scss',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  host: {
    '(document:keydown.escape)': 'onEscape()',
    '(document:mousedown)': 'onDocumentMouseDown($event)',
  },
})
export class QuickChatComponent {
  readonly quickChat = inject(QuickChatService);
  readonly speech = inject(SpeechRecognitionService);
  private readonly aiAssistant = inject(AiAssistantService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly entityService = inject(EntityService);
  private readonly bookService = inject(BookService);
  private readonly chapterService = inject(ChapterService);
  readonly editorBridge = inject(EditorBridgeService);
  readonly userSettings = inject(UserSettingsService);
  private readonly ngZone = inject(NgZone);

  // ── Drag-to-reposition (desktop only) ────────────────────────────────────
  readonly dragPos = signal<{ left: number; top: number } | null>(null);
  readonly isDragging = signal(false);
  private dragOffset = { x: 0, y: 0 };
  private readonly boundMouseMove = (e: MouseEvent) =>
    this.ngZone.run(() => this.handleDragMove(e));
  private readonly boundMouseUp = () =>
    this.ngZone.run(() => this.handleDragEnd());

  /** Ghost-complete: the saved prompt snippet whose text starts with the current
   *  input, suggested as greyed text and accepted with Tab. */
  /** The chapter context currently registered from the editor, if any. */
  private readonly chapterContext = computed(() => this.editorBridge.captureContext());
  /** True when the active session can be pinned to the current chapter. */
  readonly canPinToChapter = computed(() =>
    !!this.quickChat.activeSessionId() &&
    !!this.chapterContext()?.chapterId &&
    this.quickChat.pinnedChapterId() !== this.chapterContext()!.chapterId,
  );
  /** True when the active session is already pinned to the current chapter. */
  readonly isPinnedToCurrentChapter = computed(() =>
    !!this.quickChat.pinnedChapterId() &&
    this.quickChat.pinnedChapterId() === this.chapterContext()?.chapterId,
  );

  pinToCurrentChapter(): void {
    const chapterId = this.chapterContext()?.chapterId;
    if (chapterId) void this.quickChat.pinToChapter(chapterId);
  }

  unpinFromCurrentChapter(): void {
    void this.quickChat.unpinFromChapter();
  }

  readonly ghostSuggestion = computed<GhostCompleteItem | null>(() => {
    const inputVal = this.input();
    if (!inputVal) return null;
    const lower = inputVal.toLowerCase();
    return this.userSettings.ghostCompleteItems().find(
      item => item.prompt.toLowerCase().startsWith(lower) && item.prompt.length > inputVal.length,
    ) ?? null;
  });
  readonly ghostSuffix = computed(() => {
    const s = this.ghostSuggestion();
    return s ? s.prompt.slice(this.input().length) : '';
  });

  readonly input = signal('');
  /** The map shown in the full-screen read-only viewer, if any. */
  readonly previewedMap = signal<MapPreview | null>(null);

  // Cache rendered HTML per message object. Because the service creates a new
  // message object on every streaming chunk, cache misses during streaming are
  // expected and fine. Once streaming ends the reference stabilises, so
  // subsequent change-detection passes return the *same* SafeHtml reference —
  // Angular skips the [innerHTML] update and the user's text selection survives.
  private readonly htmlCache = new WeakMap<ChatSessionMessage, SafeHtml>();

  readonly highlightColors = [
    { value: '#ffe066', label: 'Yellow' },
    { value: '#b9fbc0', label: 'Green' },
    { value: '#b3d9ff', label: 'Blue' },
    { value: '#ffb3c6', label: 'Pink' },
  ];
  readonly highlightToolbar = signal<{ x: number; y: number; messageIndex: number } | null>(null);
  private pendingHighlightSelection: { startOffset: number; endOffset: number; messageIndex: number } | null = null;
  readonly showHighlightsSummary = signal(false);
  readonly activeHighlightId = signal<string | null>(null);
  readonly sessionName = computed(() => {
    const id = this.quickChat.activeSessionId();
    if (!id) return null;
    return this.aiAssistant.sessions().find(s => s.id === id)?.name ?? null;
  });

  readonly allHighlights = computed(() => {
    const msgs = this.quickChat.messages();
    const entries: Array<{ messageIndex: number; highlight: ChatMessageHighlight; excerpt: string }> = [];
    msgs.forEach((msg, i) => {
      if (!msg.highlights?.length) return;
      const plain = this.getMessagePlainText(msg);
      for (const hl of msg.highlights) {
        const raw = plain.slice(hl.startOffset, hl.endOffset);
        const excerpt = raw.length > 90 ? raw.slice(0, 88) + '…' : raw;
        entries.push({ messageIndex: i, highlight: hl, excerpt });
      }
    });
    entries.sort((a, b) => a.messageIndex - b.messageIndex || a.highlight.startOffset - b.highlight.startOffset);
    return entries;
  });

  // Generated-image actions
  readonly lightboxUrl = signal<string | null>(null);
  readonly imageToast = signal<string | null>(null);
  private imageToastTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Slash-command menu (discoverable agentic actions) ─────────────────────
  /** Commands offered in the current context (filters out chapter-only ones
   *  when the overlay wasn't opened from an editor). Also backs the empty-state
   *  chips. */
  readonly availableSlashCommands = computed<SlashCommand[]>(() => {
    const hasChapter = this.editorBridge.hasChapterContext();
    return SLASH_COMMANDS.filter(c => !c.requiresChapter || hasChapter);
  });
  /** Up to five commands surfaced as one-tap chips in the empty state. */
  readonly slashChips = computed(() => this.availableSlashCommands().slice(0, 4));
  readonly slashItems = signal<SlashCommand[]>([]);
  readonly slashIndex = signal(0);
  readonly slashOpen = signal(false);

  // ── Entity / chapter / book typeahead ────────────────────────────────────
  private readonly entities = signal<Entity[]>([]);
  private readonly books = signal<AcItem[]>([]);
  private readonly chapters = signal<AcItem[]>([]);
  private resourcesLoaded = false;
  readonly acItems = signal<AcItem[]>([]);
  readonly acIndex = signal(0);
  readonly acOpen = signal(false);
  /** Bounds of the partial word the typeahead is completing, within the input. */
  private tokenStart = 0;
  private tokenEnd = 0;
  /** True once the user has arrowed through the autocomplete list; enables Enter to select. */
  private acNavigated = false;

  private readonly inputEl = viewChild<ElementRef<HTMLTextAreaElement>>('inputEl');
  private readonly messagesEl = viewChild<ElementRef<HTMLDivElement>>('messagesEl');
  private readonly cardEl = viewChild<ElementRef<HTMLElement>>('cardEl');

  /** Empty-state Quilly intro: what (if anything) Quilly is currently saying. */
  readonly emptySpeech = signal('');
  /** Whether the action chips are revealed yet (after the intro delay). */
  readonly showEmptyChips = signal(false);
  private emptyOptionsTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyIntroStarted = false;


  constructor() {
    // Focus the input whenever the panel expands, and lazily load the resource
    // pool (entities, books, chapters) the first time it's shown.
    effect(() => {
      if (!this.quickChat.minimized()) {
        this.loadResources();
        queueMicrotask(() => this.inputEl()?.nativeElement.focus());
      }
    });

    // Keep the latest message in view as content streams in and when streaming
    // ends (including the early-exit navigate path which returns before [DONE]).
    effect(() => {
      this.quickChat.messages();
      this.quickChat.streaming();
      const el = this.messagesEl()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });

    // Auto-grow the composer: start at one row, expand up to four, then scroll.
    // Driven by the input signal so every mutation (typing, ghost-complete,
    // dictation, send-clear) re-measures.
    effect(() => {
      this.input();
      queueMicrotask(() => this.autoGrowTextarea());
    });

    // Drive the empty-state Quilly intro: speak the welcome line on appearance,
    // then offer the action chips if the user is still idle after a delay.
    effect(() => {
      const showingEmpty =
        this.quickChat.isOpen() &&
        !this.quickChat.minimized() &&
        this.quickChat.messages().length === 0;
      if (showingEmpty) {
        this.startEmptyIntro();
      } else {
        this.resetEmptyIntro();
      }
    });

    inject(DestroyRef).onDestroy(() => this.clearEmptyOptionsTimer());
  }

  /** Speak the intro once, then reveal the chips after the options delay. */
  private startEmptyIntro(): void {
    if (this.emptyIntroStarted) return;
    this.emptyIntroStarted = true;
    this.showEmptyChips.set(false);
    this.emptySpeech.set(QC_INTRO);
    this.clearEmptyOptionsTimer();
    this.emptyOptionsTimer = setTimeout(() => {
      this.emptyOptionsTimer = null;
      if (this.quickChat.messages().length === 0) {
        this.emptySpeech.set(QC_OPTIONS);
        this.showEmptyChips.set(true);
      }
    }, QC_OPTIONS_DELAY_MS);
  }

  private resetEmptyIntro(): void {
    this.emptyIntroStarted = false;
    this.clearEmptyOptionsTimer();
    this.emptySpeech.set('');
    this.showEmptyChips.set(false);
  }

  private clearEmptyOptionsTimer(): void {
    if (this.emptyOptionsTimer !== null) {
      clearTimeout(this.emptyOptionsTimer);
      this.emptyOptionsTimer = null;
    }
  }

  renderHtml(msg: ChatSessionMessage, msgIndex = 0): SafeHtml {
    if (!this.htmlCache.has(msg)) {
      let html = chatMarkdownToHtml(msg.text, msg.sources);
      if (msg.highlights?.length) {
        html = this.applyHighlightsToHtml(html, msg.highlights, msgIndex);
      }
      this.htmlCache.set(msg, this.sanitizer.bypassSecurityTrustHtml(html));
    }
    return this.htmlCache.get(msg)!;
  }

  /** Resizes the composer to fit its content, from 1 row up to a 4-row cap
   *  (after which it scrolls). */
  private static readonly TEXTAREA_MAX_ROWS = 4;
  private autoGrowTextarea(): void {
    const el = this.inputEl()?.nativeElement;
    if (!el) return;
    const styles = getComputedStyle(el);
    let lineHeight = parseFloat(styles.lineHeight);
    if (!Number.isFinite(lineHeight)) lineHeight = parseFloat(styles.fontSize) * 1.4;
    const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const border = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
    // Measure the natural content height with the field collapsed.
    el.style.height = 'auto';
    const contentHeight = el.scrollHeight; // includes padding (border-box)
    const maxContent = lineHeight * QuickChatComponent.TEXTAREA_MAX_ROWS + padding;
    el.style.height = `${Math.min(contentHeight, maxContent) + border}px`;
    el.style.overflowY = contentHeight > maxContent ? 'auto' : 'hidden';
  }

  /** Formats a message's ISO timestamp for display in the chat (e.g. "Jun 19, 2:34 PM"). */
  formatTimestamp(iso: string | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  onCitationClick(event: MouseEvent): void {
    const chapterId = chapterIdFromClick(event);
    if (!chapterId) return;
    event.preventDefault();
    this.quickChat.close();
    this.router.navigate(['/chapters', chapterId, 'edit']);
  }

  /** Opens the full-screen read-only viewer for a map thumbnail in the chat. */
  openMapPreview(map: MapPreview): void {
    this.previewedMap.set(map);
  }

  /** Jumps from the read-only viewer into the editor, closing both overlays. */
  editPreviewedMap(): void {
    const id = this.previewedMap()?.id;
    this.previewedMap.set(null);
    this.quickChat.close();
    if (id) this.router.navigate(['/maps', id]);
  }

  /** Rewrites a stored upload URL to the same-origin image proxy. */
  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }

  // ── Generated-image actions ─────────────────────────────────────────────

  openLightbox(imageUrl: string): void {
    this.lightboxUrl.set(this.proxyUrl(imageUrl));
  }

  closeLightbox(): void {
    this.lightboxUrl.set(null);
  }

  private showImageToast(message: string): void {
    this.imageToast.set(message);
    if (this.imageToastTimer) clearTimeout(this.imageToastTimer);
    this.imageToastTimer = setTimeout(() => this.imageToast.set(null), 3000);
  }

  /** Save a generated image into a chosen entity's photo gallery. */
  async saveToGallery(msg: ChatSessionMessage): Promise<void> {
    if (!msg.imageUrl) return;
    const ref = this.dialog.open(EntityPickerDialogComponent, {
      data: { seriesId: null } satisfies EntityPickerData,
      autoFocus: false,
    });
    const entity = await firstValueFrom(ref.afterClosed());
    if (!entity) return;
    try {
      await firstValueFrom(
        this.entityService.addPhoto(entity.id, msg.imageUrl, msg.thumbnailUrl ?? msg.imageUrl),
      );
      this.showImageToast(`Saved to ${entity.name}'s gallery.`);
    } catch {
      this.showImageToast('Could not save to gallery.');
    }
  }

  /** Save a generated image as a file in a chosen Resource Manager folder. */
  async saveToResourceManager(msg: ChatSessionMessage): Promise<void> {
    if (!msg.imageUrl) return;
    const ref = this.dialog.open(FolderLocationPickerDialogComponent, {
      data: { seriesId: null, requireFolder: true } satisfies FolderLocationPickerData,
      autoFocus: false,
    });
    const location: FolderLocation | undefined = await firstValueFrom(ref.afterClosed());
    if (!location?.folderId) return;
    try {
      const url = this.proxyUrl(msg.imageUrl);
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], 'generated-image.png', { type: blob.type || 'image/png' });
      const ok = await this.quickChat.uploadImageToFolder(location.folderId, file);
      this.showImageToast(ok ? 'Saved to Resource Manager.' : 'Could not save to Resource Manager.');
    } catch {
      this.showImageToast('Could not save to Resource Manager.');
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    // While the slash menu is open, arrows/Enter/Tab/Escape drive it. Enter and
    // Tab both pick the highlighted command (rather than sending).
    if (this.slashOpen() && this.slashItems().length > 0) {
      const n = this.slashItems().length;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.slashIndex.update(i => (i + 1) % n);
        this.scrollActiveSlashIntoView();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.slashIndex.update(i => (i - 1 + n) % n);
        this.scrollActiveSlashIntoView();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.acceptSlash(this.slashItems()[this.slashIndex()]);
        return;
      }
      if (event.key === 'Escape') {
        // Dismiss the menu only — don't let the overlay's Esc handler fire.
        event.preventDefault();
        event.stopPropagation();
        this.closeSlash();
        return;
      }
    }

    // While the entity/chapter/book typeahead is open, arrows/Tab/Escape drive it.
    // Enter only selects once the user has arrowed through options; otherwise it sends.
    if (this.acOpen() && this.acItems().length > 0) {
      const n = this.acItems().length;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.acNavigated = true;
        this.acIndex.update(i => (i + 1) % n);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.acNavigated = true;
        this.acIndex.update(i => (i - 1 + n) % n);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && this.acNavigated)) {
        event.preventDefault();
        this.acceptAcItem(this.acItems()[this.acIndex()]);
        return;
      }
      if (event.key === 'Escape') {
        // Dismiss the typeahead only — don't let the overlay's Esc handler fire.
        event.preventDefault();
        event.stopPropagation();
        this.closeAutocomplete();
        return;
      }
    }

    // Tab accepts the ghost-complete suggestion (when the entity typeahead isn't open).
    if (event.key === 'Tab' && this.ghostSuggestion()) {
      event.preventDefault();
      this.applyGhostComplete();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  applyGhostComplete(): void {
    const s = this.ghostSuggestion();
    if (s) this.input.set(s.prompt);
  }

  // Captured on mousedown so the selection isn't lost by the time click fires.
  private pendingInsertSelection: string | null = null;

  onInsertMouseDown(event: MouseEvent, msg: ChatSessionMessage): void {
    event.preventDefault(); // keep focus on the message text, preserving selection
    const sel = window.getSelection();
    this.pendingInsertSelection = (sel && !sel.isCollapsed) ? sel.toString().trim() : null;
  }

  /** Inserts into the active chapter editor at the cursor, marked as AI-generated.
   *  Uses only the currently selected text when a non-empty selection exists
   *  within the message; otherwise inserts the full message text. */
  insertAtCursor(msg: ChatSessionMessage): void {
    if (!msg.text) return;
    const text = this.pendingInsertSelection || msg.text;
    const insertedWholeDraft = msg.kind === 'chapter-draft' && !this.pendingInsertSelection;
    this.pendingInsertSelection = null;
    this.editorBridge.insertText(text);
    this.quickChat.minimize();
    // Accepting a full chapter draft updates canon — run extraction on it.
    if (insertedWholeDraft) this.editorBridge.notifyDraftAccepted();
  }

  // ── Chapter-draft actions ─────────────────────────────────────────────────

  /** Indices of draft messages whose beat sheet ("Story plan") is expanded. */
  readonly openBeats = signal<ReadonlySet<number>>(new Set());

  isBeatsOpen(index: number): boolean {
    return this.openBeats().has(index);
  }

  toggleBeats(index: number): void {
    this.openBeats.update(set => {
      const next = new Set(set);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }

  /** Renders a draft's beat sheet (markdown) for display. */
  renderBeats(msg: ChatSessionMessage): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(chatMarkdownToHtml(msg.beats ?? ''));
  }

  /** Replaces the entire chapter with the draft prose, after confirmation. */
  replaceChapter(msg: ChatSessionMessage): void {
    if (!msg.text) return;
    const ok = window.confirm('Replace the entire chapter with this draft? Your current text will be overwritten (you can undo, and version history is kept).');
    if (!ok) return;
    this.editorBridge.replaceContent(msg.text);
    this.quickChat.minimize();
    // Replacing the chapter with a draft updates canon — run extraction on it.
    this.editorBridge.notifyDraftAccepted();
  }

  /** Seeds the composer with a revision instruction so the author can refine the
   *  draft in a follow-up turn. */
  reviseDraft(): void {
    this.input.set('Revise the draft: ');
    this.inputEl()?.nativeElement.focus();
  }

  // ── Smart edit proposal card ─────────────────────────────────────────────
  /** Applies a proposed edit into the chapter, or toasts if it can't be placed. */
  applyEdit(messageIndex: number): void {
    const ok = this.quickChat.applyEditProposal(messageIndex);
    if (ok) this.showImageToast('Edit applied to your chapter.');
    else this.showImageToast("Couldn't place this edit — the text may have changed. Ask Quill to propose it again.");
  }

  /** Discards a proposed edit and clears its preview from the editor. */
  discardEdit(messageIndex: number): void {
    this.quickChat.discardEditProposal(messageIndex);
  }

  editProposalLabel(edit: ChapterEditProposal): string {
    switch (edit.kind) {
      case 'insert': return 'Add content';
      case 'replace': return 'Change content';
      case 'delete': return 'Remove content';
    }
  }

  editProposalIcon(edit: ChapterEditProposal): string {
    switch (edit.kind) {
      case 'insert': return 'add';
      case 'replace': return 'edit';
      case 'delete': return 'remove';
    }
  }

  // ── Entity-link session card ─────────────────────────────────────────────
  /** Links every occurrence of the current term and advances to the next. */
  linkAllMatches(messageIndex: number): void {
    this.quickChat.linkEntityGroup(messageIndex);
  }

  /** Skips the current term and advances to the next. */
  skipMatches(messageIndex: number): void {
    this.quickChat.skipEntityGroup(messageIndex);
  }

  /** Ends the link session early, leaving remaining terms untouched. */
  stopLinking(messageIndex: number): void {
    this.quickChat.stopLinkSession(messageIndex);
  }

  /** True once every term in the session has been linked or skipped. */
  linkSessionDone(session: EntityLinkSession): boolean {
    return session.index >= session.groups.length;
  }

  /** The term currently awaiting a decision, or null when the session is done. */
  linkSessionCurrent(session: EntityLinkSession): EntityLinkGroup | null {
    return session.groups[session.index] ?? null;
  }

  /** The groups the author acted on, for the post-session summary. */
  linkSessionReviewed(session: EntityLinkSession): EntityLinkGroup[] {
    return session.groups.filter(g => g.status);
  }

  /** Collapses the panel and returns focus to the editor at the cursor position
   *  it held before the overlay was opened. */
  closeOverlay(): void {
    this.quickChat.minimize();
    this.editorBridge.restoreFocus();
  }

  /** Collapses the panel to the corner bar. Returns the caret to the editor so the
   *  user can keep writing with the panel tucked away. */
  minimize(): void {
    this.quickChat.minimize();
    this.editorBridge.restoreFocus();
  }

  /** Expands the panel from the corner bar and focuses the input. */
  restorePanel(): void {
    this.quickChat.restore();
    queueMicrotask(() => this.inputEl()?.nativeElement.focus());
  }

  send(): void {
    const text = this.input().trim();
    if (!text || this.quickChat.streaming()) return;
    this.closeAutocomplete();
    this.input.set('');
    void this.quickChat.sendMessage(text);
  }

  // ── Push-to-talk dictation ────────────────────────────────────────────────

  /** Text in the input when dictation began; the transcript is appended to it. */
  private speechBaseText = '';
  /** Prevents late-arriving speech callbacks from overwriting the input after send. */
  private dictationActive = false;

  /** Begins listening; live transcript is appended to whatever was already typed. */
  startDictation(event: Event): void {
    event.preventDefault(); // keep the mic button from stealing focus / scrolling
    if (!this.speech.supported || this.speech.recording() || this.quickChat.streaming()) return;
    this.closeAutocomplete();
    const existing = this.input().trimEnd();
    this.speechBaseText = existing ? existing + ' ' : '';
    this.dictationActive = true;
    this.speech.start(transcript => {
      if (this.dictationActive) this.input.set(this.speechBaseText + transcript);
    });
  }

  /** Stops listening and sends the transcribed message if there's content. */
  stopDictation(): void {
    if (!this.speech.recording()) return;
    this.dictationActive = false; // block any final async speech callbacks before send clears input
    this.speech.stop();
    this.send();
  }

  /** Space/Enter held on the mic button starts dictation (keyboard push-to-talk). */
  onMicKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.startDictation(event);
    }
  }

  /** Releasing the held key ends dictation. */
  onMicKeyUp(event: KeyboardEvent): void {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.stopDictation();
    }
  }

  newChat(): void {
    this.quickChat.reset();
    this.showHighlightsSummary.set(false);
    this.activeHighlightId.set(null);
    queueMicrotask(() => this.inputEl()?.nativeElement.focus());
  }

  // ── Entity / chapter / book typeahead ────────────────────────────────────

  private loadResources(): void {
    if (this.resourcesLoaded) return;
    this.resourcesLoaded = true;
    forkJoin({
      entities: this.entityService.getAll(),
      books: this.bookService.getAll(),
      chapters: this.chapterService.getAll(),
    }).subscribe({
      next: ({ entities, books, chapters }) => {
        this.entities.set(
          entities
            .filter(e => !e.deleted && !e.archived)
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        this.books.set(
          books
            .filter(b => !b.deleted && !b.archived)
            .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
            .map(b => ({ kind: 'book' as const, id: b.id, name: b.title ?? '' }))
            .filter(b => b.name),
        );
        this.chapters.set(
          chapters
            .filter(c => !c.archived)
            .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
            .map(c => ({ kind: 'chapter' as const, id: c.id, name: c.title ?? '' }))
            .filter(c => c.name),
        );
      },
      error: () => { this.resourcesLoaded = false; },
    });
  }

  /** Called on every input event; updates the value and the typeahead. */
  onInput(value: string): void {
    this.input.set(value);
    // The slash menu and entity typeahead are mutually exclusive: a leading `/`
    // means the user is choosing a command, not naming an entity.
    if (this.refreshSlash(value)) {
      this.closeAutocomplete();
      return;
    }
    this.refreshAutocomplete(value);
  }

  // ── Slash-command menu ────────────────────────────────────────────────────

  /** Shows/filters the slash menu while the input is just `/word` (no space yet).
   *  Returns true when the menu is active so the caller can suppress the entity
   *  typeahead. */
  private refreshSlash(value: string): boolean {
    const match = /^\/(\p{L}*)$/u.exec(value);
    if (!match) {
      this.closeSlash();
      return false;
    }
    const q = match[1].toLowerCase();
    const items = this.availableSlashCommands().filter(
      c => c.command.startsWith(q) || c.keywords.some(k => k.startsWith(q)),
    );
    if (items.length === 0) {
      this.closeSlash();
      return false;
    }
    this.slashItems.set(items);
    this.slashIndex.set(0);
    this.slashOpen.set(true);
    return true;
  }

  closeSlash(): void {
    this.slashOpen.set(false);
    this.slashItems.set([]);
  }

  /** Keeps the keyboard-highlighted command visible as the user arrows past the
   *  menu's scroll boundary. Targets the item by index (the list DOM already
   *  exists), so it stays in sync without waiting for the `active` class to be
   *  applied by change detection. */
  private scrollActiveSlashIntoView(): void {
    const idx = this.slashIndex();
    const items = document.querySelectorAll('.qc-slash-item');
    items[idx]?.scrollIntoView({ block: 'nearest' });
  }

  onSlashMouseDown(event: MouseEvent, cmd: SlashCommand): void {
    // Keep focus on the textarea so its blur doesn't dismiss the menu first.
    event.preventDefault();
    this.acceptSlash(cmd);
  }

  /** Picks a command from the menu. Route commands navigate immediately;
   *  scaffold commands seed the composer for the user to complete. */
  acceptSlash(cmd: SlashCommand): void {
    this.closeSlash();
    this.applyCommandScaffold(cmd);
  }

  /** Navigates instantly (route commands) or seeds the composer (scaffold
   *  commands). Shared by the slash menu and the empty-state chips. */
  applyCommandScaffold(cmd: SlashCommand): void {
    if (cmd.action === 'minimize') {
      this.input.set('');
      this.quickChat.minimize();
      return;
    }
    if (cmd.action === 'new-chat') {
      this.input.set('');
      this.newChat();
      return;
    }
    if (cmd.action === 'open-resources') {
      this.input.set('');
      this.quickChat.minimize();
      this.aiAssistant.togglePanel();
      return;
    }
    if (cmd.route) {
      this.input.set('');
      this.quickChat.minimize();
      this.router.navigateByUrl(cmd.route);
      return;
    }
    this.input.set(cmd.scaffold);
    queueMicrotask(() => {
      const el = this.inputEl()?.nativeElement;
      el?.focus();
      const end = cmd.scaffold.length;
      el?.setSelectionRange(end, end);
    });
  }

  /** Closes both in-composer menus when the textarea loses focus. */
  onBlur(): void {
    this.closeAutocomplete();
    this.closeSlash();
  }

  private refreshAutocomplete(value: string): void {
    const el = this.inputEl()?.nativeElement;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    // The word immediately left of the caret (letters, digits, apostrophes, hyphens).
    const match = before.match(/([\p{L}][\p{L}\d'’-]*)$/u);
    const word = match?.[1] ?? '';
    if (word.length < 2) {
      this.closeAutocomplete();
      return;
    }

    const q = word.toLowerCase();

    const entityMatches = (e: Entity) =>
      [e.name, e.firstName, e.lastName, e.nickname].some(v => v?.toLowerCase().includes(q));
    const entityStartsWith = (e: Entity) =>
      [e.name, e.firstName, e.lastName, e.nickname].some(v => v?.toLowerCase().startsWith(q));
    const entityItems: AcItem[] = this.entities()
      .filter(entityMatches)
      .sort((a, b) => Number(entityStartsWith(b)) - Number(entityStartsWith(a)))
      .slice(0, 5)
      .map(e => ({ kind: 'entity' as const, id: e.id, name: e.name, entityType: e.type }));

    const titleMatches = (item: AcItem) => item.name.toLowerCase().includes(q);
    const titleStartsWith = (item: AcItem) => item.name.toLowerCase().startsWith(q);
    const sortByStartsWith = (a: AcItem, b: AcItem) => Number(titleStartsWith(b)) - Number(titleStartsWith(a));

    const bookItems = this.books().filter(titleMatches).sort(sortByStartsWith).slice(0, 3);
    const chapterItems = this.chapters().filter(titleMatches).sort(sortByStartsWith).slice(0, 3);

    const items = [...entityItems, ...chapterItems, ...bookItems].slice(0, 8);

    if (items.length === 0) {
      this.closeAutocomplete();
      return;
    }
    this.tokenStart = caret - word.length;
    this.tokenEnd = caret;
    this.acItems.set(items);
    this.acIndex.set(0);
    this.acNavigated = false;
    this.acOpen.set(true);
  }

  onItemMouseDown(event: MouseEvent, item: AcItem): void {
    // Prevent the textarea from losing focus before we re-insert the name.
    event.preventDefault();
    this.acceptAcItem(item);
  }

  private acceptAcItem(item: AcItem): void {
    const value = this.input();
    const name = item.name;
    const newValue = value.slice(0, this.tokenStart) + name + ' ' + value.slice(this.tokenEnd);
    this.input.set(newValue);
    this.closeAutocomplete();
    const caret = this.tokenStart + name.length + 1;
    queueMicrotask(() => {
      const el = this.inputEl()?.nativeElement;
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  closeAutocomplete(): void {
    this.acOpen.set(false);
    this.acItems.set([]);
    this.acNavigated = false;
  }

  acItemIcon(item: AcItem): string {
    if (item.kind === 'book') return 'menu_book';
    if (item.kind === 'chapter') return 'article';
    return item.entityType === 'PLACE' ? 'place' : item.entityType === 'THING' ? 'category' : 'person';
  }

  acItemTypeLabel(item: AcItem): string {
    if (item.kind === 'book') return 'Book';
    if (item.kind === 'chapter') return 'Chapter';
    return item.entityType.charAt(0) + item.entityType.slice(1).toLowerCase();
  }

  // ── Highlight toolbar ───────────────────────────────────────────────────

  onDocumentMouseDown(event: MouseEvent): void {
    const toolbarEl = document.querySelector('.qc-highlight-toolbar');
    if (toolbarEl && !toolbarEl.contains(event.target as Node)) {
      window.getSelection()?.removeAllRanges();
      this.highlightToolbar.set(null);
      this.pendingHighlightSelection = null;
    }
  }

  onMessagesMouseUp(): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      this.highlightToolbar.set(null);
      this.pendingHighlightSelection = null;
      return;
    }

    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const markdownEl = ancestor?.closest('.qc-markdown') as HTMLElement | null;
    if (!markdownEl) {
      this.highlightToolbar.set(null);
      this.pendingHighlightSelection = null;
      return;
    }

    const msgEl = markdownEl.closest('[data-msg-index]') as HTMLElement | null;
    const messageIndex = msgEl ? parseInt(msgEl.dataset['msgIndex'] ?? '-1', 10) : -1;
    if (messageIndex < 0) {
      this.highlightToolbar.set(null);
      this.pendingHighlightSelection = null;
      return;
    }

    const startOffset = this.getTextOffset(markdownEl, range.startContainer, range.startOffset);
    const endOffset = this.getTextOffset(markdownEl, range.endContainer, range.endOffset);
    if (startOffset >= endOffset) {
      this.highlightToolbar.set(null);
      this.pendingHighlightSelection = null;
      return;
    }

    this.pendingHighlightSelection = { startOffset, endOffset, messageIndex };

    const rect = range.getBoundingClientRect();
    const toolbarWidth = 200;
    const toolbarHeight = 44;
    const margin = 8;

    let x = rect.left + rect.width / 2 - toolbarWidth / 2;
    let y = rect.top - toolbarHeight - margin;

    x = Math.max(margin, Math.min(x, window.innerWidth - toolbarWidth - margin));
    if (y < margin) y = rect.bottom + margin;
    y = Math.min(y, window.innerHeight - toolbarHeight - margin);

    this.highlightToolbar.set({ x, y, messageIndex });
  }

  private getTextOffset(root: Node, targetNode: Node, targetOffset: number): number {
    let offset = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node === targetNode) return offset + targetOffset;
      offset += node.textContent?.length ?? 0;
    }
    return offset + targetOffset;
  }

  async applyHighlight(color: string): Promise<void> {
    if (!this.pendingHighlightSelection) return;
    const { startOffset, endOffset, messageIndex } = this.pendingHighlightSelection;
    const highlight: ChatMessageHighlight = {
      id: crypto.randomUUID(),
      startOffset,
      endOffset,
      color,
    };
    this.highlightToolbar.set(null);
    this.pendingHighlightSelection = null;
    window.getSelection()?.removeAllRanges();
    await this.quickChat.addHighlight(messageIndex, highlight);
  }

  async eraseHighlights(): Promise<void> {
    if (!this.pendingHighlightSelection) return;
    const { startOffset, endOffset, messageIndex } = this.pendingHighlightSelection;
    this.highlightToolbar.set(null);
    this.pendingHighlightSelection = null;
    window.getSelection()?.removeAllRanges();
    await this.quickChat.removeHighlightsInRange(messageIndex, startOffset, endOffset);
  }

  navigateToHighlight(messageIndex: number, highlightId: string): void {
    this.activeHighlightId.set(highlightId);
    const container = this.messagesEl()?.nativeElement;
    if (!container) return;
    const markEl = container.querySelector(`mark[data-highlight-id="${highlightId}"]`) as HTMLElement | null;
    const target = markEl ?? (container.querySelector(`[data-msg-index="${messageIndex}"]`) as HTMLElement | null);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (markEl) {
      markEl.classList.remove('qc-highlight-flash');
      void markEl.offsetWidth;
      markEl.classList.add('qc-highlight-flash');
    }
  }

  navigateToNextHighlight(): void {
    const all = this.allHighlights();
    if (!all.length) return;
    const idx = all.findIndex(e => e.highlight.id === this.activeHighlightId());
    const next = all[(idx + 1) % all.length];
    this.navigateToHighlight(next.messageIndex, next.highlight.id);
  }

  navigateToPrevHighlight(): void {
    const all = this.allHighlights();
    if (!all.length) return;
    const idx = all.findIndex(e => e.highlight.id === this.activeHighlightId());
    const prev = all[(idx - 1 + all.length) % all.length];
    this.navigateToHighlight(prev.messageIndex, prev.highlight.id);
  }

  private getMessagePlainText(msg: ChatSessionMessage): string {
    const html = chatMarkdownToHtml(msg.text, msg.sources);
    const div = document.createElement('div');
    div.innerHTML = html;
    return div.textContent ?? '';
  }

  private applyHighlightsToHtml(rawHtml: string, highlights: ChatMessageHighlight[], msgIndex: number): string {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<body>${rawHtml}</body>`, 'text/html');
    const root = doc.body;
    // Process highest startOffset first to avoid cumulative offset drift
    const sorted = [...highlights].sort((a, b) => b.startOffset - a.startOffset);
    for (const hl of sorted) {
      this.applyHighlightNode(root, hl, msgIndex);
    }
    return root.innerHTML;
  }

  private applyHighlightNode(root: Element, hl: ChatMessageHighlight, msgIndex: number): void {
    const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    let cumOffset = 0;
    const toWrap: { node: Text; from: number; to: number }[] = [];

    for (const node of textNodes) {
      const len = node.length;
      const nodeStart = cumOffset;
      const nodeEnd = cumOffset + len;
      if (nodeEnd <= hl.startOffset || nodeStart >= hl.endOffset) {
        cumOffset += len;
        continue;
      }
      toWrap.push({
        node,
        from: Math.max(0, hl.startOffset - nodeStart),
        to: Math.min(len, hl.endOffset - nodeStart),
      });
      cumOffset += len;
    }

    for (const { node, from, to } of [...toWrap].reverse()) {
      const parent = node.parentNode;
      if (!parent) continue;
      try {
        const after = node.splitText(to);
        const highlighted = node.splitText(from);
        const mark = root.ownerDocument!.createElement('mark');
        mark.className = 'qc-chat-highlight';
        mark.style.background = hl.color;
        mark.dataset['highlightId'] = hl.id;
        mark.dataset['msgIndex'] = String(msgIndex);
        parent.insertBefore(mark, after);
        mark.appendChild(highlighted);
      } catch {
        // Skip if DOM structure prevents wrapping (e.g. complex overlaps)
      }
    }
  }

  onDragStart(event: MouseEvent): void {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    event.preventDefault();
    const card = this.cardEl()?.nativeElement;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    this.dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.dragPos.set({ left: rect.left, top: rect.top });
    this.isDragging.set(true);
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('mouseup', this.boundMouseUp, { once: true });
  }

  private handleDragMove(event: MouseEvent): void {
    const card = this.cardEl()?.nativeElement;
    if (!card) return;
    let left = event.clientX - this.dragOffset.x;
    let top = event.clientY - this.dragOffset.y;
    left = Math.max(0, Math.min(left, window.innerWidth - card.offsetWidth));
    top = Math.max(0, Math.min(top, window.innerHeight - card.offsetHeight));
    this.dragPos.set({ left, top });
  }

  private handleDragEnd(): void {
    document.removeEventListener('mousemove', this.boundMouseMove);
    this.isDragging.set(false);
  }

  onEscape(): void {
    // The image lightbox sits on top of everything — Escape dismisses it first.
    if (this.lightboxUrl()) {
      this.closeLightbox();
      return;
    }
    // The map viewer sits on top of the chat — Escape dismisses it first.
    if (this.previewedMap()) {
      this.previewedMap.set(null);
      return;
    }
    // Non-modal panel: only close on Escape when focus is inside it, so pressing
    // Escape while working in the page beneath doesn't dismiss the conversation.
    // Ignore while a child dialog (e.g. the save picker) is open on top.
    const card = this.cardEl()?.nativeElement;
    const focusInside = card?.contains(document.activeElement);
    if (this.quickChat.isOpen() && !this.quickChat.minimized() && focusInside && this.dialog.openDialogs.length === 0) {
      this.closeOverlay();
    }
  }
}
