import {
  ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, OnDestroy, signal, untracked, viewChild,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { liveDialogue, LiveDialogue } from '@app/core/read-aloud/dialogue-paragraphs';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';
import { DialogueTaggingService } from '@app/features/chapters/dialogue-tagging.service';
import { displayName } from '@app/shared/voice-gallery/voice-filter';
import { proxyImageUrl } from '@app/core/utils/image-proxy';
import { Entity } from '@shared/models/entity.model';
import {
  DialogueHighlightsService, NARRATION_HIGHLIGHT, PENDING_HIGHLIGHT, SPEAKER_COLORS, speakerHighlight,
} from './dialogue-highlights';

/** Wait after the text changes before finding its dialogue again. */
const RESCAN_MS = 400;
/** Hover this long before the card shows, and leave for this long before it hides. */
const SHOW_MS = 300;
const HIDE_MS = 250;
/** A filter box appears in the speaker list past this many characters. */
const FILTER_AFTER = 8;

/** Who says a line: not worked out yet, nobody (narration voice), or a character. */
export type LineSpeaker =
  | { kind: 'pending' }
  | { kind: 'none' }
  | { kind: 'entity'; entity: Entity; slot: number; color: string };

/** The characters who can speak, in a stable order that decides their colors. */
export function speakingCharacters(entities: readonly Entity[]): Entity[] {
  return entities
    .filter(e => e.type === 'PERSON' && !e.archived && !e.deleted)
    .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Colors each line of dialogue in a chapter editor by who speaks it, shows a
 * card naming the speaker on hover, and lets the author correct the speaker
 * when the model got it wrong. Lines edited since the last save have no
 * speaker until it's saved again (their attribution is cleared on edit).
 */
@Component({
  selector: 'app-dialogue-speakers',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dialogue-speakers.html',
  styleUrl: './dialogue-speakers.scss',
})
export class DialogueSpeakersComponent implements OnDestroy {
  /** The editor's contenteditable element. */
  readonly editor = input<HTMLElement | null>(null);
  /** The chapter shown in the editor; nothing happens without one. */
  readonly chapterId = input<string | null>(null);
  readonly entities = input<readonly Entity[]>([]);

  private readonly tagging = inject(DialogueTaggingService);
  private readonly highlights = inject(DialogueHighlightsService);
  private readonly readAloud = inject(ReadAloudService);
  private readonly cardRef = viewChild<ElementRef<HTMLElement>>('card');

  readonly characters = computed(() => speakingCharacters(this.entities()));
  private readonly lines = signal<LiveDialogue[]>([]);
  private readonly dialogue = computed(() => {
    const id = this.chapterId();
    return id ? this.tagging.dialogue()[id] : undefined;
  });
  /** Finds lines and shows the hover card whenever a chapter is open. */
  readonly enabled = computed(() => !!this.chapterId());
  /** Colors them only while the "Color dialogue by speaker" setting is on. */
  private readonly painted = computed(() => this.enabled() && this.highlights.visible());

  /** The line the card is about, and where the card sits. */
  readonly active = signal<LiveDialogue | null>(null);
  readonly cardTop = signal(0);
  readonly cardLeft = signal(0);
  readonly changing = signal(false);
  readonly filter = signal('');
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  readonly speaker = computed(() => {
    const line = this.active();
    return line ? this.speakerOf(line) : null;
  });
  readonly kind = computed(() => this.speaker()?.kind ?? 'pending');
  readonly speakerEntity = computed(() => { const s = this.speaker(); return s?.kind === 'entity' ? s.entity : null; });
  readonly speakerColor = computed(() => { const s = this.speaker(); return s?.kind === 'entity' ? s.color : null; });
  readonly isTagging = computed(() => this.tagging.tagging().has(this.chapterId() ?? ''));
  readonly voiceName = computed(() => {
    const s = this.speaker();
    if (s?.kind !== 'entity' || !s.entity.voiceId) return null;
    const voice = this.readAloud.azureCatalog().find(v => v.id === s.entity.voiceId);
    return voice ? displayName(voice) : null;
  });
  readonly options = computed(() => {
    const q = this.filter().trim().toLowerCase();
    return this.characters()
      .map((entity, slot) => ({ entity, color: SPEAKER_COLORS[slot % SPEAKER_COLORS.length]! }))
      .filter(o => !q || o.entity.name.toLowerCase().includes(q));
  });
  readonly showFilter = computed(() => this.characters().length > FILTER_AFTER);

  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private frame = 0;
  private lastPoint: { x: number; y: number } | null = null;
  private readonly onMove = (e: MouseEvent) => this.pointerMoved(e.clientX, e.clientY);
  private readonly onLeave = () => { this.cancelShow(); this.scheduleHide(); };
  private readonly onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && this.active()) this.close(); };
  private readonly onDocDown = (e: MouseEvent) => {
    const card = this.cardRef()?.nativeElement;
    if (this.active() && card && !card.contains(e.target as Node)) this.close();
  };

  constructor() {
    // Watch the editor: rescan when its text changes, track the pointer over it.
    effect(onCleanup => {
      const editor = this.editor();
      const enabled = this.enabled();
      if (!editor || !enabled) {
        untracked(() => { this.lines.set([]); this.close(); });
        return;
      }
      this.observer = new MutationObserver(() => this.scheduleRescan());
      this.observer.observe(editor, { childList: true, characterData: true, subtree: true });
      editor.addEventListener('mousemove', this.onMove);
      editor.addEventListener('mouseleave', this.onLeave);
      document.addEventListener('keydown', this.onKey);
      document.addEventListener('mousedown', this.onDocDown, true);
      untracked(() => this.rescan());
      onCleanup(() => {
        this.observer?.disconnect();
        this.observer = null;
        editor.removeEventListener('mousemove', this.onMove);
        editor.removeEventListener('mouseleave', this.onLeave);
        document.removeEventListener('keydown', this.onKey);
        document.removeEventListener('mousedown', this.onDocDown, true);
      });
    });

    // Repaint when the lines, their speakers or the characters change.
    effect(() => {
      const lines = this.lines();
      if (!this.painted()) { this.highlights.remove(this); return; }
      const groups = new Map<string, Range[]>();
      for (const line of lines) {
        const s = this.speakerOf(line);
        const name = s.kind === 'pending' ? PENDING_HIGHLIGHT
          : s.kind === 'none' ? NARRATION_HIGHLIGHT
          : speakerHighlight(s.slot);
        groups.set(name, [...(groups.get(name) ?? []), line.range]);
      }
      this.highlights.update(this, groups);
    });
  }

  ngOnDestroy(): void {
    this.highlights.remove(this);
    for (const t of [this.rescanTimer, this.showTimer, this.hideTimer]) if (t) clearTimeout(t);
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  // ── For the editor's context menu ────────────────────────────────────────

  /** The line of dialogue holding the caret (or selection start), if any. */
  lineAtSelection(): LiveDialogue | null {
    if (!this.enabled()) return null;
    const sel = document.getSelection();
    if (!sel?.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return this.lineAtPosition(r.startContainer, r.startOffset);
  }

  /** Opens the card on a line, straight into the speaker list. */
  openChanger(line: LiveDialogue): void {
    this.cancelShow();
    this.open(line, line.range.getBoundingClientRect());
    if (this.speakerOf(line).kind !== 'pending') this.startChange();
  }

  // ── Card actions ──────────────────────────────────────────────────────────

  startChange(): void {
    this.changing.set(true);
    this.filter.set('');
    this.error.set(null);
    setTimeout(() => this.cardRef()?.nativeElement.querySelector<HTMLElement>('.dlg-filter, .dlg-option')?.focus());
  }

  async choose(entityId: string | null): Promise<void> {
    const line = this.active();
    const chapterId = this.chapterId();
    if (!line || !chapterId || this.saving()) return;
    this.saving.set(true);
    const error = await this.tagging.setSpeaker(chapterId, line.key, line.index, entityId);
    this.saving.set(false);
    if (error) this.error.set(error);
    else this.close();
  }

  close(): void {
    this.cancelShow();
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.active.set(null);
    this.changing.set(false);
    this.error.set(null);
  }

  cardEntered(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  cardLeave(): void {
    this.scheduleHide();
  }

  /** The entity's picture through the image proxy, or null to show its initial. */
  avatar(entity: Entity): string | null {
    return proxyImageUrl(entity.thumbnailUrl || entity.originalUrl);
  }

  initial(entity: Entity): string {
    return entity.name.trim().charAt(0).toUpperCase() || '?';
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  speakerOf(line: LiveDialogue): LineSpeaker {
    const speakers = this.dialogue()?.[line.key];
    if (!speakers) return { kind: 'pending' };
    const id = speakers[line.index];
    const characters = this.characters();
    const slot = id ? characters.findIndex(c => c.id === id) : -1;
    if (slot < 0) return { kind: 'none' };
    return { kind: 'entity', entity: characters[slot]!, slot, color: SPEAKER_COLORS[slot % SPEAKER_COLORS.length]! };
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => { this.rescanTimer = null; this.rescan(); }, RESCAN_MS);
  }

  private rescan(): void {
    const editor = this.editor();
    if (!editor || !this.enabled()) return;
    const lines = liveDialogue(editor);
    this.lines.set(lines);
    // The open card's line may have been edited away.
    const active = this.active();
    if (active && !lines.some(l => l.key === active.key && l.index === active.index)) this.close();
    else if (active) this.active.set(lines.find(l => l.key === active.key && l.index === active.index)!);
  }

  private pointerMoved(x: number, y: number): void {
    this.lastPoint = { x, y };
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const p = this.lastPoint;
      if (p) this.hover(p.x, p.y);
    });
  }

  private hover(x: number, y: number): void {
    const hit = this.lineAtPoint(x, y);
    const active = this.active();
    if (hit && active && hit.line === active) { this.cardEntered(); return; }
    if (this.changing()) return; // Don't swap the card out from under a choice.
    this.cancelShow();
    if (!hit) { if (active) this.scheduleHide(); return; }
    this.showTimer = setTimeout(() => { this.showTimer = null; this.open(hit.line, hit.rect); }, SHOW_MS);
  }

  private open(line: LiveDialogue, rect: DOMRect): void {
    const CARD_W = 280;
    const CARD_H = 140;
    const GAP = 6;
    const off = fixedOffset(this.editor());
    const below = rect.bottom + GAP + CARD_H <= window.innerHeight;
    this.cardTop.set((below ? rect.bottom + GAP : Math.max(GAP, rect.top - GAP - CARD_H)) - off.y);
    this.cardLeft.set(Math.max(GAP, Math.min(rect.left, window.innerWidth - CARD_W - GAP)) - off.x);
    this.changing.set(false);
    this.error.set(null);
    this.active.set(line);
  }

  private cancelShow(): void {
    if (this.showTimer) clearTimeout(this.showTimer);
    this.showTimer = null;
  }

  private scheduleHide(): void {
    if (this.changing() || this.hideTimer) return;
    this.hideTimer = setTimeout(() => { this.hideTimer = null; if (!this.changing()) this.close(); }, HIDE_MS);
  }

  /** The line under the pointer, and the box of the bit of it there. */
  private lineAtPoint(x: number, y: number): { line: LiveDialogue; rect: DOMRect } | null {
    const pos = caretAt(x, y);
    if (!pos) return null;
    const line = this.lineAtPosition(pos.node, pos.offset);
    if (!line) return null;
    // The caret snaps to the nearest text, so make sure the pointer is really on the line.
    const rect = [...line.range.getClientRects()].find(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    return rect ? { line, rect } : null;
  }

  private lineAtPosition(node: Node, offset: number): LiveDialogue | null {
    for (const line of this.lines()) {
      try {
        if (line.range.isPointInRange(node, offset)) return line;
      } catch {
        // Node from another document or detached: not ours.
      }
    }
    return null;
  }
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** position:fixed is relative to a transformed ancestor, not the viewport, inside one (e.g. a slide-out panel). */
function fixedOffset(from: HTMLElement | null): { x: number; y: number } {
  for (let el = from?.parentElement ?? null; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    if ((s.transform && s.transform !== 'none') || (s.filter && s.filter !== 'none')
      || s.willChange.includes('transform') || s.willChange.includes('filter')) {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top };
    }
  }
  return { x: 0, y: 0 };
}
