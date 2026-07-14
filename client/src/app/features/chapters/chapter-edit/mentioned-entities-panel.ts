import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Entity } from '@shared/models/entity.model';
import { RichTextEditorComponent } from '@app/shared/rich-text-editor/rich-text-editor';

/**
 * Facepile of the entities mentioned in the chapter. Collapsed it shows a
 * stack of overlapping avatars (plus a "+N" overflow badge); hovering or
 * focusing the panel fans the avatars out horizontally. Hovering an avatar
 * shows a seeker bar to step through that entity's mentions in the editor
 * (scroll + highlight); clicking an avatar emits entitySelected so the host
 * can open its details.
 */
@Component({
  selector: 'app-mentioned-entities-panel',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mention-panel" role="group" aria-label="Entities mentioned in this chapter"
      (mouseleave)="clearActive()">
      @for (entity of entities(); track entity.id) {
        <button type="button" class="entity-row"
          [class.stack-overflow]="$index >= maxCollapsed"
          [class.seek-active]="activeEntity()?.id === entity.id"
          [style.z-index]="entities().length - $index"
          (click)="entitySelected.emit(entity)"
          (mouseenter)="requestActive(entity)"
          (mouseleave)="cancelPendingActive()"
          (focus)="setActive(entity)"
          [attr.aria-label]="'View details for ' + entity.name">
          @if (thumbUrl(entity); as url) {
            <img class="entity-avatar" [src]="url" alt="" />
          } @else {
            <span class="entity-avatar entity-avatar-placeholder">
              <mat-icon>{{ typeIcon(entity) }}</mat-icon>
            </span>
          }
        </button>
      }
      @if (hiddenCount() > 0) {
        <span class="overflow-badge" aria-hidden="true">+{{ hiddenCount() }}</span>
      }

      <!-- Seeker bar: step through the hovered entity's mentions -->
      @if (activeEntity(); as active) {
        <div class="seek-bar" [style.left.px]="seekBarLeft()">
          <div class="seek-bar-inner" role="toolbar"
            [attr.aria-label]="'Find mentions of ' + active.name">
            <span class="seek-name">{{ active.name }}</span>
            <button type="button" class="seek-btn" (click)="seek(-1)"
              [disabled]="seekCount() === 0"
              [attr.aria-label]="'Previous mention of ' + active.name">
              <mat-icon>chevron_left</mat-icon>
            </button>
            <span class="seek-count" aria-live="polite">
              @if (seekIndex() >= 0) {
                {{ seekIndex() + 1 }} / {{ seekCount() }}
              } @else {
                {{ seekCount() }} mention{{ seekCount() === 1 ? '' : 's' }}
              }
            </span>
            <button type="button" class="seek-btn" (click)="seek(1)"
              [disabled]="seekCount() === 0"
              [attr.aria-label]="'Next mention of ' + active.name">
              <mat-icon>chevron_right</mat-icon>
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .mention-panel {
      display: flex;
      align-items: center;
      padding: 4px;
      border: 1px solid transparent;
      border-radius: 20px;
      position: relative;
    }

    .entity-row {
      display: flex;
      border: none;
      background: none;
      padding: 0;
      cursor: pointer;
      border-radius: 50%;
      position: relative;
      transition: margin-left 0.15s ease, transform 0.15s ease;
    }

    .entity-row + .entity-row { margin-left: -10px; }
    .entity-row.stack-overflow { display: none; }

    .entity-avatar {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      object-fit: cover;
      border: 2px solid var(--mat-sys-surface, #fff);
      box-sizing: border-box;
      display: block;
      flex-shrink: 0;
    }

    .entity-avatar-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--mat-sys-surface-container-high, #e0e0e0);
      color: var(--mat-sys-on-surface-variant, #757575);

      mat-icon { font-size: 18px; width: 18px; height: 18px; line-height: 18px; }
    }

    .overflow-badge {
      width: 30px;
      height: 30px;
      margin-left: -10px;
      border-radius: 50%;
      border: 2px solid var(--mat-sys-surface, #fff);
      box-sizing: border-box;
      background: var(--mat-sys-surface-container-highest, #e0e0e0);
      color: var(--mat-sys-on-surface-variant, #555);
      font-size: 0.6875rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    /* ── Fanned out (hover / keyboard focus) ───────────── */
    .mention-panel:hover,
    .mention-panel:focus-within {
      background: var(--mat-sys-surface, #fff);
      border-color: var(--mat-sys-outline-variant, #e0e0e0);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);

      .entity-row + .entity-row { margin-left: 4px; }
      .entity-row.stack-overflow { display: flex; }
      .overflow-badge { display: none; }

      .entity-row:hover,
      .entity-row:focus-visible,
      .entity-row.seek-active {
        transform: scale(1.6);
        z-index: 100 !important; /* pop above the inline z-index stacking order */
      }
    }

    /* ── Seeker bar ────────────────────────────────────── */
    /* Centered below the hovered avatar so the pointer path down to it never
       crosses a sibling avatar; padding-top bridges the gap so the pointer
       never leaves the panel's hover area on the way down. */
    .seek-bar {
      position: absolute;
      top: 100%;
      transform: translateX(-50%);
      padding-top: 6px;
      z-index: 110;
    }

    .seek-bar-inner {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 6px;
      background: var(--mat-sys-surface, #fff);
      border: 1px solid var(--mat-sys-outline-variant, #e0e0e0);
      border-radius: 18px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
      white-space: nowrap;
    }

    .seek-name {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--mat-sys-on-surface, #212121);
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 4px;
    }

    .seek-count {
      font-size: 0.75rem;
      color: var(--mat-sys-on-surface-variant, #757575);
      min-width: 48px;
      text-align: center;
    }

    .seek-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 50%;
      background: none;
      cursor: pointer;
      color: var(--mat-sys-on-surface-variant, #555);

      &:hover:not(:disabled) { background: var(--mat-sys-surface-container-high, rgba(0, 0, 0, 0.06)); }
      &:disabled { opacity: 0.4; cursor: default; }

      mat-icon { font-size: 20px; width: 20px; height: 20px; line-height: 20px; }
    }
  `,
})
export class MentionedEntitiesPanelComponent {
  entities = input.required<Entity[]>();
  /** Editor instance used to count/scroll-to mentions (same pattern as the review panel). */
  editor = input<RichTextEditorComponent | null>(null);
  entitySelected = output<Entity>();

  /** Avatars shown in the collapsed stack; the rest fold into the "+N" badge. */
  protected readonly maxCollapsed = 5;

  hiddenCount = computed(() => Math.max(0, this.entities().length - this.maxCollapsed));

  // ── Seek state ────────────────────────────────────────────────────────────
  activeEntity = signal<Entity | null>(null);
  /** 0-based position within the entity's mentions; -1 until the first seek. */
  seekIndex = signal(-1);
  seekCount = signal(0);
  private pendingActiveTimer: ReturnType<typeof setTimeout> | null = null;

  // Fanned-row geometry (must match the styles): panel padding 4px, avatar
  // 30px, gap 4px → the bar centers under the active avatar.
  private static readonly PANEL_PAD = 4;
  private static readonly ROW_STEP = 34;
  seekBarLeft = computed(() => {
    const active = this.activeEntity();
    if (!active) return 0;
    const i = Math.max(0, this.entities().findIndex(e => e.id === active.id));
    return MentionedEntitiesPanelComponent.PANEL_PAD +
      i * MentionedEntitiesPanelComponent.ROW_STEP +
      MentionedEntitiesPanelComponent.ROW_STEP / 2 - 2;
  });

  /** Hover-intent activation: switching to a different entity waits briefly so
   *  brushing past a sibling avatar on the way to the seek bar doesn't steal it. */
  requestActive(entity: Entity): void {
    this.cancelPendingActive();
    if (!this.activeEntity() || this.activeEntity()?.id === entity.id) {
      this.setActive(entity);
      return;
    }
    this.pendingActiveTimer = setTimeout(() => {
      this.pendingActiveTimer = null;
      this.setActive(entity);
    }, 150);
  }

  cancelPendingActive(): void {
    if (this.pendingActiveTimer) {
      clearTimeout(this.pendingActiveTimer);
      this.pendingActiveTimer = null;
    }
  }

  setActive(entity: Entity): void {
    if (this.activeEntity()?.id === entity.id) return;
    this.editor()?.clearEntitySeekHighlight();
    this.activeEntity.set(entity);
    this.seekIndex.set(-1);
    this.seekCount.set(this.editor()?.countEntityReferences(entity.id) ?? 0);
  }

  clearActive(): void {
    this.cancelPendingActive();
    this.activeEntity.set(null);
    this.seekIndex.set(-1);
    this.editor()?.clearEntitySeekHighlight();
  }

  seek(direction: 1 | -1): void {
    const entity = this.activeEntity();
    const editor = this.editor();
    if (!entity || !editor) return;
    const count = editor.countEntityReferences(entity.id);
    this.seekCount.set(count);
    if (count === 0) return;
    const current = this.seekIndex();
    const next = current === -1
      ? (direction === 1 ? 0 : count - 1)
      : (current + direction + count) % count;
    this.seekIndex.set(next);
    editor.scrollToEntityReference(entity.id, next);
  }

  thumbUrl(entity: Entity): string | null {
    const url = entity.thumbnailUrl || entity.originalUrl;
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  typeIcon(entity: Entity): string {
    return entity.type === 'PERSON' ? 'person' : entity.type === 'PLACE' ? 'place' : 'category';
  }
}
