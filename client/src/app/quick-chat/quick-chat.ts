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
import { ChatSessionMessage, MapPreview } from '@shared/models';
import { Entity } from '@shared/models/entity.model';
import { QuickChatService } from '../services/quick-chat.service';
import { EntityService } from '../services/entity.service';
import { chatMarkdownToHtml, chapterIdFromClick } from '../shared/chat-markdown';
import { MapPreviewComponent } from '../maps/map-preview/map-preview';
import { SaveChatDialogComponent } from './save-chat-dialog';

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
  },
})
export class QuickChatComponent {
  readonly quickChat = inject(QuickChatService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly entityService = inject(EntityService);

  readonly input = signal('');
  readonly justSaved = signal(false);
  /** The map shown in the full-screen read-only viewer, if any. */
  readonly previewedMap = signal<MapPreview | null>(null);

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

  /** A conversation can be saved once it has at least one completed exchange. */
  readonly canSave = computed(
    () => !this.quickChat.streaming() && this.quickChat.messages().some(m => m.role === 'assistant' && m.text),
  );

  constructor() {
    // Focus the input whenever the overlay opens, and lazily load the entity
    // pool (across all series) the first time it's shown.
    effect(() => {
      if (this.quickChat.isOpen()) {
        this.justSaved.set(false);
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

  renderHtml(msg: ChatSessionMessage): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(chatMarkdownToHtml(msg.text, msg.sources));
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

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }

  send(): void {
    const text = this.input().trim();
    if (!text || this.quickChat.streaming()) return;
    this.closeAutocomplete();
    this.input.set('');
    this.justSaved.set(false);
    void this.quickChat.sendMessage(text);
  }

  newChat(): void {
    this.quickChat.reset();
    this.justSaved.set(false);
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

  async openSaveDialog(): Promise<void> {
    if (!this.canSave()) return;
    const saved = await firstValueFrom(
      this.dialog.open(SaveChatDialogComponent, { autoFocus: false }).afterClosed(),
    );
    if (saved) this.justSaved.set(true);
  }

  onEscape(): void {
    // The map viewer sits on top of the chat — Escape dismisses it first.
    if (this.previewedMap()) {
      this.previewedMap.set(null);
      return;
    }
    // Ignore while a dialog (e.g. the save picker) is open on top — Escape
    // should dismiss that first, not the whole conversation.
    if (this.quickChat.isOpen() && this.dialog.openDialogs.length === 0) {
      this.quickChat.close();
    }
  }
}
