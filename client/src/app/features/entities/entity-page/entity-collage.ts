import { Component, ChangeDetectionStrategy, computed, input, output, signal } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Entity } from '@shared/models/entity.model';

interface CollageTile {
  id: string;
  name: string;
  count: number;
  span: number;
  imageUrl: string | null;
  initial: string;
  rotation: number;
  zIndex: number;
}

@Component({
  selector: 'app-entity-collage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatProgressSpinnerModule],
  template: `
    <div class="collage" role="list" aria-label="Entity photo collage, sized by mentions">
      @for (tile of tiles(); track tile.id) {
        <button class="tile"
                role="listitem"
                [style.--span]="tile.span"
                [style.--rotation]="tile.rotation + 'deg'"
                [style.--z]="tile.zIndex"
                [class.tile--placeholder]="!tile.imageUrl"
                [class.tile--drag-over]="dragOverId() === tile.id"
                [class.tile--uploading]="uploadingEntityId() === tile.id"
                (click)="entitySelected.emit(tile.id)"
                (dragover)="onTileDragOver($event, tile.id)"
                (dragleave)="onTileDragLeave($event)"
                (drop)="onTileDrop($event, tile.id)"
                [attr.aria-label]="tile.name + ', ' + tile.count + (tile.count === 1 ? ' mention' : ' mentions')">
          @if (tile.imageUrl) {
            <img [src]="tile.imageUrl" [alt]="tile.name" loading="lazy" />
          } @else {
            <span class="tile-initial" aria-hidden="true">{{ tile.initial }}</span>
          }
          <span class="tile-overlay">
            <span class="tile-name">{{ tile.name }}</span>
          </span>
          @if (uploadingEntityId() === tile.id) {
            <div class="tile-upload-overlay" aria-hidden="true"><mat-spinner diameter="32" /></div>
          }
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      padding: 24px;
      box-sizing: border-box;
      background: #000;
      min-height: 100%;
    }

    .collage {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
      grid-auto-rows: 80px;
      grid-auto-flow: dense;
      gap: 0;
      max-width: 1100px;
      margin: 0 auto;
      padding: 12px;
    }

    .tile {
      all: unset;
      cursor: pointer;
      position: relative;
      overflow: hidden;
      grid-column: span var(--span);
      grid-row: span var(--span);
      transform: rotate(var(--rotation)) scale(1.07);
      z-index: var(--z);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      background: var(--mat-sys-surface-container-high);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.18s ease, box-shadow 0.18s ease;

      img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      &:hover {
        transform: rotate(0deg) scale(1.14);
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
        z-index: 50;
      }

      &:focus-visible {
        outline: 2px solid var(--mat-sys-primary);
        outline-offset: 2px;
        z-index: 50;
      }
    }

    .tile--placeholder {
      background: color-mix(in srgb, var(--mat-sys-primary) 8%, var(--mat-sys-surface-container-high));
    }

    .tile--drag-over {
      outline: 3px dashed var(--mat-sys-primary);
      outline-offset: -3px;
      transform: rotate(0deg) scale(1.1) !important;
      z-index: 50 !important;
    }

    .tile--uploading {
      pointer-events: none;
    }

    .tile-upload-overlay {
      position: absolute;
      inset: 0;
      background: color-mix(in srgb, var(--mat-sys-surface) 60%, transparent);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .tile-initial {
      font-size: calc(20px * var(--span));
      font-weight: 600;
      color: var(--mat-sys-on-surface-variant);
      user-select: none;
    }

    .tile-overlay {
      position: absolute;
      inset: auto 0 0 0;
      display: flex;
      align-items: center;
      padding: 14px 8px 6px;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.65));
      color: #fff;
      font-size: 0.75rem;
      pointer-events: none;
    }

    .tile-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 500;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    }
  `,
})
export class EntityCollageComponent {
  entities = input.required<Entity[]>();
  counts = input.required<Record<string, number>>();
  uploadingEntityId = input<string | null>(null);
  entitySelected = output<string>();
  fileDrop = output<{ entityId: string; files: File[] }>();

  dragOverId = signal<string | null>(null);

  tiles = computed<CollageTile[]>(() => {
    const counts = this.counts();
    const entities = this.entities();
    const max = Math.max(1, ...entities.map(e => counts[e.id] ?? 0));
    return entities
      .map(e => {
        const count = counts[e.id] ?? 0;
        const name = e.isNarrator ? 'Narrator' : (e.name || '(unnamed)');
        return {
          id: e.id,
          name,
          count,
          span: this.spanFor(count, max),
          imageUrl: this.proxyUrl(e.thumbnailUrl),
          initial: name.trim().charAt(0).toUpperCase() || '?',
          // -4.5..4.5 degrees, stable per entity
          rotation: (Math.abs(this.hash(e.id + ':rot')) % 91) / 10 - 4.5,
          zIndex: (Math.abs(this.hash(e.id + ':z')) % 8) + 1,
        };
      })
      // Scatter tiles in a stable pseudo-random order (hash of entity id) so
      // the collage feels organic rather than ranked, without reshuffling on
      // every render. grid-auto-flow: dense backfills the gaps.
      .sort((a, b) => this.hash(a.id) - this.hash(b.id));
  });

  onTileDragOver(event: DragEvent, entityId: string): void {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (this.dragOverId() !== entityId) this.dragOverId.set(entityId);
  }

  onTileDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (!(event.currentTarget as HTMLElement).contains(related)) {
      this.dragOverId.set(null);
    }
  }

  onTileDrop(event: DragEvent, entityId: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragOverId.set(null);
    const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    this.fileDrop.emit({ entityId, files });
  }

  private hash(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = (h * 31 + id.charCodeAt(i)) | 0;
    }
    return h;
  }

  // Tile edge scales with the square root of the mention count (so tile *area*
  // tracks the count), bucketed into grid spans of 1-4 relative to the most
  // mentioned entity in the series.
  private spanFor(count: number, max: number): number {
    if (count === 0) return 1;
    const ratio = Math.sqrt(count / max);
    if (ratio > 0.75) return 4;
    if (ratio > 0.45) return 3;
    if (ratio > 0.2) return 2;
    return 1;
  }

  private proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }
}
