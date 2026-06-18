import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
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
import { firstValueFrom } from 'rxjs';
import { ChatMessageHighlight, ChatSessionMessage, MapPreview } from '@shared/models';
import { Entity } from '@shared/models/entity.model';
import { QuickChatService } from '../services/quick-chat.service';
import { AiAssistantService } from '../services/ai-assistant.service';
import { EntityService } from '../services/entity.service';
import { EditorBridgeService } from '../services/editor-bridge.service';
import { UserSettingsService, GhostCompleteItem } from '../services/user-settings.service';
import { chatMarkdownToHtml, chapterIdFromClick } from '../shared/chat-markdown';
import { MapPreviewComponent } from '../maps/map-preview/map-preview';
import { EntityPickerDialogComponent, EntityPickerData } from '../entity-edit/entity-picker-dialog';
import { FolderLocationPickerDialogComponent, FolderLocation, FolderLocationPickerData } from '../ai-assistant/folder-location-picker-dialog';

/**
 * The quick-launch "Ask Quill" overlay (Ctrl/Cmd+I). A centered, spotlight-style
 * modal for asking questions answered with cross-series vector search. Ephemeral
 * by default — the Save action persists the conversation into the Resource Manager.
 */
@Component({
  selector: 'app-quick-chat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, MatProgressSpinnerModule, MapPreviewComponent],
  templateUrl: './quick-chat.html',
  styleUrl: './quick-chat.scss',
  host: {
    '(document:keydown.escape)': 'onEscape()',
    '(document:mousedown)': 'onDocumentMouseDown($event)',
  },
})
export class QuickChatComponent {
  readonly quickChat = inject(QuickChatService);
  private readonly aiAssistant = inject(AiAssistantService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly entityService = inject(EntityService);
  readonly editorBridge = inject(EditorBridgeService);
  private readonly userSettings = inject(UserSettingsService);

  /** Ghost-complete: the saved prompt snippet whose text starts with the current
   *  input, suggested as greyed text and accepted with Tab. */
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

  // ── Entity typeahead ──────────────────────────────────────────────────────
  private readonly entities = signal<Entity[]>([]);
  private entitiesLoaded = false;
  readonly acItems = signal<Entity[]>([]);
  readonly acIndex = signal(0);
  readonly acOpen = signal(false);
  /** Bounds of the partial word the typeahead is completing, within the input. */
  private tokenStart = 0;
  private tokenEnd = 0;

  private readonly inputEl = viewChild<ElementRef<HTMLTextAreaElement>>('inputEl');
  private readonly messagesEl = viewChild<ElementRef<HTMLDivElement>>('messagesEl');
  private readonly cardEl = viewChild<ElementRef<HTMLElement>>('cardEl');


  constructor() {
    // Focus the input whenever the panel expands, and lazily load the entity
    // pool (across all series) the first time it's shown.
    effect(() => {
      if (!this.quickChat.minimized()) {
        this.loadEntities();
        queueMicrotask(() => this.inputEl()?.nativeElement.focus());
      }
    });

    // Keep the latest message in view as the answer streams in.
    effect(() => {
      this.quickChat.messages();
      const el = this.messagesEl()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
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
    // While the entity typeahead is open, arrows/Enter/Tab/Escape drive it.
    if (this.acOpen() && this.acItems().length > 0) {
      const n = this.acItems().length;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.acIndex.update(i => (i + 1) % n);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.acIndex.update(i => (i - 1 + n) % n);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.acceptEntity(this.acItems()[this.acIndex()]);
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
    this.pendingInsertSelection = null;
    this.editorBridge.insertText(text);
    this.quickChat.minimize();
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

  newChat(): void {
    this.quickChat.reset();
    this.showHighlightsSummary.set(false);
    this.activeHighlightId.set(null);
    queueMicrotask(() => this.inputEl()?.nativeElement.focus());
  }

  // ── Entity typeahead ──────────────────────────────────────────────────────

  private loadEntities(): void {
    if (this.entitiesLoaded) return;
    this.entitiesLoaded = true;
    this.entityService.getAll().subscribe({
      next: list => this.entities.set(
        list
          .filter(e => !e.deleted && !e.archived)
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
      error: () => { this.entitiesLoaded = false; },
    });
  }

  /** Called on every input event; updates the value and the typeahead. */
  onInput(value: string): void {
    this.input.set(value);
    this.refreshAutocomplete(value);
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
    const matched = (e: Entity) =>
      [e.name, e.firstName, e.lastName, e.nickname].some(v => v?.toLowerCase().includes(q));
    const startsWith = (e: Entity) =>
      [e.name, e.firstName, e.lastName, e.nickname].some(v => v?.toLowerCase().startsWith(q));
    const items = this.entities()
      .filter(matched)
      .sort((a, b) => Number(startsWith(b)) - Number(startsWith(a)))
      .slice(0, 8);

    if (items.length === 0) {
      this.closeAutocomplete();
      return;
    }
    this.tokenStart = caret - word.length;
    this.tokenEnd = caret;
    this.acItems.set(items);
    this.acIndex.set(0);
    this.acOpen.set(true);
  }

  onItemMouseDown(event: MouseEvent, entity: Entity): void {
    // Prevent the textarea from losing focus before we re-insert the name.
    event.preventDefault();
    this.acceptEntity(entity);
  }

  private acceptEntity(entity: Entity): void {
    const value = this.input();
    const name = entity.name;
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
  }

  entityIcon(entity: Entity): string {
    return entity.type === 'PLACE' ? 'place' : entity.type === 'THING' ? 'category' : 'person';
  }

  entityTypeLabel(entity: Entity): string {
    return entity.type.charAt(0) + entity.type.slice(1).toLowerCase();
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
