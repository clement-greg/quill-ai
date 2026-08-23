import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { Entity, isVideoUrl } from '@shared/models/entity.model';
import { Series } from '@shared/models/series.model';
import { EntityService } from '../entity.service';
import { SeriesService } from '@app/features/series/series.service';

export interface MovePhotoDialogData {
  /** Proxied thumbnail of the photo or video being moved, shown for confirmation. */
  thumbnailUrl: string;
  /** Original blob url — only used to tell a video from a still. */
  url: string;
  caption?: string;
  /** The entity the photo is on now; it is left out of the destination list. */
  currentEntityId: string;
  /** Series the destination list starts on. */
  currentSeriesId: string;
}

export interface MovePhotoDialogResult {
  targetEntityId: string;
  targetEntityName: string;
}

/**
 * Picks the entity a gallery photo or video should move to. The list starts on
 * the photo's own series — the common case — and the series dropdown re-scopes
 * it when the destination lives elsewhere.
 */
@Component({
  selector: 'app-move-photo-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>Move {{ isVideo ? 'video' : 'photo' }}</h2>
    <mat-dialog-content>
      <div class="preview">
        @if (isVideo) {
          <video [src]="data.thumbnailUrl + '#t=0.1'" preload="metadata" muted playsinline></video>
        } @else {
          <img [src]="data.thumbnailUrl" [alt]="data.caption || 'Photo being moved'" />
        }
        <p class="preview-hint">Choose the entity this should belong to.</p>
      </div>

      <mat-form-field appearance="outline" class="field">
        <mat-label>Series</mat-label>
        <mat-select [ngModel]="seriesId()" (ngModelChange)="onSeriesChange($event)">
          @for (s of series(); track s.id) {
            <mat-option [value]="s.id">{{ s.title }}</mat-option>
          }
        </mat-select>
      </mat-form-field>

      <mat-form-field appearance="outline" class="field">
        <mat-label>Search entities</mat-label>
        <input matInput [ngModel]="search()" (ngModelChange)="search.set($event)" placeholder="Name" />
        <mat-icon matSuffix>search</mat-icon>
      </mat-form-field>

      <div class="entity-list" role="listbox" aria-label="Destination entity">
        @if (loading()) {
          <div class="list-state"><mat-spinner diameter="28"></mat-spinner></div>
        } @else if (filteredEntities().length === 0) {
          <p class="list-state">No other entities in this series.</p>
        } @else {
          @for (e of filteredEntities(); track e.id) {
            <button type="button" class="entity-row"
                    role="option"
                    [class.entity-row--selected]="targetId() === e.id"
                    [attr.aria-selected]="targetId() === e.id"
                    (click)="targetId.set(e.id)"
                    (dblclick)="confirm()">
              @if (e.thumbnailUrl) {
                <img class="entity-thumb" [src]="proxyUrl(e.thumbnailUrl)" [alt]="''" />
              } @else {
                <span class="entity-thumb entity-thumb--empty"><mat-icon>person</mat-icon></span>
              }
              <span class="entity-name">{{ e.name }}</span>
              <span class="entity-type">{{ typeLabel(e.type) }}</span>
            </button>
          }
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!targetId()" (click)="confirm()">Move</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 90vw); box-sizing: border-box; }
    .preview { display: flex; gap: 12px; align-items: center; margin: 4px 0 16px; }
    .preview img, .preview video { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; flex: 0 0 auto; }
    .preview-hint { margin: 0; font-size: 0.8rem; opacity: 0.75; }
    .field { width: 100%; }
    .entity-list {
      max-height: 40vh; overflow-y: auto; border: 1px solid rgba(128, 128, 128, 0.3);
      border-radius: 8px; display: flex; flex-direction: column;
    }
    .list-state { display: flex; justify-content: center; padding: 20px; margin: 0; font-size: 0.85rem; opacity: 0.75; }
    .entity-row {
      display: flex; align-items: center; gap: 10px; padding: 8px 10px; width: 100%;
      background: none; border: none; border-radius: 0; cursor: pointer; text-align: left;
      color: inherit; font: inherit;
    }
    .entity-row:hover { background: rgba(128, 128, 128, 0.12); }
    .entity-row--selected { background: rgba(103, 80, 164, 0.18); }
    .entity-thumb { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
    .entity-thumb--empty { display: flex; align-items: center; justify-content: center; background: rgba(128, 128, 128, 0.2); }
    .entity-thumb--empty mat-icon { font-size: 20px; width: 20px; height: 20px; opacity: 0.7; }
    .entity-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entity-type { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
  `],
})
export class MovePhotoDialogComponent {
  readonly data = inject<MovePhotoDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject<MatDialogRef<MovePhotoDialogComponent, MovePhotoDialogResult>>(MatDialogRef);
  private entityService = inject(EntityService);
  private seriesService = inject(SeriesService);

  readonly isVideo = isVideoUrl(this.data.url);

  series = signal<Series[]>([]);
  entities = signal<Entity[]>([]);
  seriesId = signal(this.data.currentSeriesId);
  targetId = signal<string | null>(null);
  search = signal('');
  loading = signal(true);

  /** The photo's own entity can't be its destination, and archived ones are hidden. */
  private candidates = computed(() =>
    this.entities().filter(e => e.id !== this.data.currentEntityId && !e.archived && !e.deleted)
  );

  filteredEntities = computed(() => {
    const term = this.search().trim().toLowerCase();
    const list = this.candidates();
    if (!term) return list;
    return list.filter(e => e.name.toLowerCase().includes(term));
  });

  constructor() {
    this.seriesService.getAll().subscribe({
      next: series => this.series.set(series.filter(s => !s.archived && !s.deleted)),
    });
    this.loadEntities(this.data.currentSeriesId);
  }

  onSeriesChange(seriesId: string): void {
    if (seriesId === this.seriesId()) return;
    this.seriesId.set(seriesId);
    // A selection made in the previous series is no longer on screen, so keeping
    // it would let "Move" send the photo somewhere the user can't see.
    this.targetId.set(null);
    this.loadEntities(seriesId);
  }

  private loadEntities(seriesId: string): void {
    this.loading.set(true);
    this.entityService.getBySeries(seriesId).subscribe({
      next: entities => {
        this.entities.set([...entities].sort((a, b) => a.name.localeCompare(b.name)));
        this.loading.set(false);
      },
      error: () => {
        this.entities.set([]);
        this.loading.set(false);
      },
    });
  }

  confirm(): void {
    const targetEntityId = this.targetId();
    if (!targetEntityId) return;
    const target = this.candidates().find(e => e.id === targetEntityId);
    if (!target) return;
    this.dialogRef.close({ targetEntityId, targetEntityName: target.name });
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  typeLabel(type: string): string {
    return type.charAt(0) + type.slice(1).toLowerCase();
  }
}
