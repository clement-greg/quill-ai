import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Entity } from '@shared/models/entity.model';

/**
 * Facepile of the entities mentioned in the chapter. Collapsed it shows a
 * stack of overlapping avatars (plus a "+N" overflow badge); hovering or
 * focusing the panel expands it into a list with names. Clicking an entity
 * emits entitySelected so the host can open its details.
 */
@Component({
  selector: 'app-mentioned-entities-panel',
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mention-panel" role="group" aria-label="Entities mentioned in this chapter">
      @for (entity of entities(); track entity.id) {
        <button type="button" class="entity-row"
          [class.stack-overflow]="$index >= maxCollapsed"
          [style.z-index]="entities().length - $index"
          (click)="entitySelected.emit(entity)"
          [attr.aria-label]="'View details for ' + entity.name">
          @if (thumbUrl(entity); as url) {
            <img class="entity-avatar" [src]="url" alt="" />
          } @else {
            <span class="entity-avatar entity-avatar-placeholder">
              <mat-icon>{{ typeIcon(entity) }}</mat-icon>
            </span>
          }
          <span class="entity-name">{{ entity.name }}</span>
        </button>
      }
      @if (hiddenCount() > 0) {
        <span class="overflow-badge" aria-hidden="true">+{{ hiddenCount() }}</span>
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
    }

    .entity-row {
      display: flex;
      align-items: center;
      gap: 8px;
      border: none;
      background: none;
      padding: 0;
      cursor: pointer;
      border-radius: 16px;
      position: relative;
      font: inherit;
      text-align: left;
    }

    .entity-row + .entity-row { margin-left: -10px; }
    .entity-row.stack-overflow { display: none; }
    .entity-name { display: none; }

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

    /* ── Expanded (hover / keyboard focus) ─────────────── */
    .mention-panel:hover,
    .mention-panel:focus-within {
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      padding: 6px;
      min-width: 190px;
      max-height: 60vh;
      overflow-y: auto;
      background: var(--mat-sys-surface, #fff);
      border-color: var(--mat-sys-outline-variant, #e0e0e0);
      border-radius: 12px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);

      .entity-row {
        margin-left: 0;
        padding: 4px 10px 4px 4px;
        border-radius: 8px;
      }

      .entity-row:hover,
      .entity-row:focus-visible {
        background: var(--mat-sys-surface-container-high, rgba(0, 0, 0, 0.06));
      }

      .entity-row.stack-overflow { display: flex; }
      .overflow-badge { display: none; }

      .entity-name {
        display: inline-block;
        font-size: 0.8125rem;
        color: var(--mat-sys-on-surface, #212121);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 180px;
      }
    }
  `,
})
export class MentionedEntitiesPanelComponent {
  entities = input.required<Entity[]>();
  entitySelected = output<Entity>();

  /** Avatars shown in the collapsed stack; the rest fold into the "+N" badge. */
  protected readonly maxCollapsed = 5;

  hiddenCount = computed(() => Math.max(0, this.entities().length - this.maxCollapsed));

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
