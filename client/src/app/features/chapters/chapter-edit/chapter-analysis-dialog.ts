import { Component, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import {
  TimelineExtractionResult,
  TimelineAddProposal,
  TimelineUpdateProposal,
  TimelineRemoveProposal,
  TimelineEventPhoto,
} from '@shared/models/timeline-event.model';
import {
  RelationshipExtractionResult,
  RelationshipAddProposal,
  RELATIONSHIP_TYPES,
} from '@shared/models/entity-relationship.model';
import { Entity, EntityPhoto } from '@shared/models/entity.model';
import { EntityService } from '@app/features/entities/entity.service';
import { PhotoPickerDialogComponent, PhotoPickerResult } from '@app/features/entities/entity-edit/photo-picker-dialog';

export interface ChapterAnalysisDialogData {
  timeline: TimelineExtractionResult & { entities: Entity[] };
  relationships: RelationshipExtractionResult;
}

export interface ChapterAnalysisDialogResult {
  timeline: { adds: TimelineAddProposal[]; updates: TimelineUpdateProposal[]; removes: TimelineRemoveProposal[] };
  relationships: { adds: RelationshipAddProposal[] };
}

const RELATIONSHIP_LABEL = new Map(RELATIONSHIP_TYPES.map(t => [t.value, t.label]));

@Component({
  selector: 'app-chapter-analysis-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MatCheckboxModule, MatProgressSpinnerModule],
  template: `
    <h2 mat-dialog-title>Proposed Chapter Changes</h2>
    <mat-dialog-content>
      <p class="intro">Changes found in this chapter. Uncheck anything you don't want applied.</p>

      <!-- ── Timeline section ── -->
      @if (tl.adds.length > 0) {
        <div class="section-header section-header--add">
          <mat-icon>add_circle</mat-icon>
          <span>New timeline events ({{ tl.adds.length }})</span>
        </div>
        @for (add of tl.adds; track $index; let i = $index) {
          <div class="proposal-row">
            <mat-checkbox [checked]="tlAddSel()[i]" (change)="toggleTlAdd(i)"
              [attr.aria-label]="'Accept new event ' + add.name" />
            <div class="proposal-body">
              <div class="proposal-title">
                <span class="event-name">{{ add.name }}</span>
                <span class="entity-chip">{{ add.entityName }}</span>
              </div>
              @if (add.timeframe) {
                <div class="event-timeframe">{{ add.timeframe }}</div>
              }
              @if (add.location) {
                <div class="event-location">
                  <mat-icon class="location-icon" aria-hidden="true">place</mat-icon>
                  @if (add.locationEntityId) {
                    <span class="location-entity-chip">{{ add.location }}</span>
                  } @else {
                    {{ add.location }}
                  }
                </div>
              }
              @if (add.description) {
                <p class="event-description">{{ add.description }}</p>
              }
              <div class="photo-section">
                @if (addPhotos()[i]; as p) {
                  <div class="photo-thumb-wrap">
                    <img class="photo-thumb" [src]="proxyUrl(p.thumbnailUrl)" alt="Event photo" />
                  </div>
                }
                <div class="photo-actions">
                  <button mat-stroked-button type="button" class="photo-btn"
                          (click)="pickPhotoForAdd(i)"
                          [disabled]="uploadingAddIndex() === i"
                          [attr.aria-label]="'Pick gallery photo for ' + add.name">
                    <mat-icon>photo_library</mat-icon>
                    Gallery
                  </button>
                  <button mat-stroked-button type="button" class="photo-btn"
                          (click)="addFileInput.click()"
                          [disabled]="uploadingAddIndex() === i"
                          [attr.aria-label]="'Upload photo for ' + add.name">
                    @if (uploadingAddIndex() === i) {
                      <mat-spinner diameter="16" class="upload-spinner" />
                    } @else {
                      <mat-icon>upload</mat-icon>
                    }
                    Upload
                  </button>
                  @if (addPhotos()[i]) {
                    <button mat-button type="button" (click)="clearAddPhoto(i)" aria-label="Remove photo">
                      Remove photo
                    </button>
                  }
                </div>
                <input type="file" hidden accept="image/*" #addFileInput
                       (change)="onAddPhotoFileSelected($event, i)" />
              </div>
            </div>
          </div>
        }
      }

      @if (tl.updates.length > 0) {
        <div class="section-header section-header--update">
          <mat-icon>edit</mat-icon>
          <span>Changed timeline events ({{ tl.updates.length }})</span>
        </div>
        @for (update of tl.updates; track update.eventId; let i = $index) {
          <div class="proposal-row">
            <mat-checkbox [checked]="tlUpdateSel()[i]" (change)="toggleTlUpdate(i)"
              [attr.aria-label]="'Accept update to ' + update.current.name" />
            <div class="proposal-body">
              <div class="proposal-title">
                <span class="event-name">{{ update.proposed.name }}</span>
                <span class="entity-chip">{{ update.entityName }}</span>
              </div>
              @if (update.reason) {
                <div class="proposal-reason">{{ update.reason }}</div>
              }
              <div class="field-diffs">
                @if (update.current.name !== update.proposed.name) {
                  <div class="field-diff">
                    <span class="diff-old">{{ update.current.name }}</span>
                    <mat-icon class="diff-arrow">arrow_forward</mat-icon>
                    <span class="diff-new">{{ update.proposed.name }}</span>
                  </div>
                }
                @if ((update.current.timeframe ?? '') !== (update.proposed.timeframe ?? '')) {
                  <div class="field-diff">
                    <span class="diff-old">{{ update.current.timeframe || '(no timeframe)' }}</span>
                    <mat-icon class="diff-arrow">arrow_forward</mat-icon>
                    <span class="diff-new">{{ update.proposed.timeframe || '(no timeframe)' }}</span>
                  </div>
                }
                @if ((update.current.description ?? '') !== (update.proposed.description ?? '')) {
                  <div class="field-diff field-diff--stacked">
                    <span class="diff-old">{{ update.current.description || '(no description)' }}</span>
                    <span class="diff-new">{{ update.proposed.description || '(no description)' }}</span>
                  </div>
                }
                @if ((update.current.location ?? '') !== (update.proposed.location ?? '') ||
                     (update.current.locationEntityId ?? '') !== (update.proposed.locationEntityId ?? '')) {
                  <div class="field-diff">
                    <mat-icon class="location-icon" aria-hidden="true">place</mat-icon>
                    <span class="diff-old">{{ update.current.location || '(no location)' }}</span>
                    <mat-icon class="diff-arrow">arrow_forward</mat-icon>
                    @if (update.proposed.locationEntityId) {
                      <span class="location-entity-chip diff-new">{{ update.proposed.location || '(no location)' }}</span>
                    } @else {
                      <span class="diff-new">{{ update.proposed.location || '(no location)' }}</span>
                    }
                  </div>
                }
              </div>
            </div>
          </div>
        }
      }

      @if (tl.removes.length > 0) {
        <div class="section-header section-header--remove">
          <mat-icon>remove_circle</mat-icon>
          <span>Removed timeline events ({{ tl.removes.length }})</span>
        </div>
        @for (remove of tl.removes; track remove.eventId; let i = $index) {
          <div class="proposal-row">
            <mat-checkbox [checked]="tlRemoveSel()[i]" (change)="toggleTlRemove(i)"
              [attr.aria-label]="'Accept removal of ' + remove.current.name" />
            <div class="proposal-body">
              <div class="proposal-title">
                <span class="event-name event-name--removed">{{ remove.current.name }}</span>
                <span class="entity-chip">{{ remove.entityName }}</span>
              </div>
              @if (remove.reason) {
                <div class="proposal-reason">{{ remove.reason }}</div>
              }
            </div>
          </div>
        }
      }

      <!-- ── Relationships section ── -->
      @if (data.relationships.adds.length > 0) {
        <div class="section-header section-header--add">
          <mat-icon>add_circle</mat-icon>
          <span>New relationships ({{ data.relationships.adds.length }})</span>
        </div>
        @for (add of data.relationships.adds; track $index; let i = $index) {
          <div class="proposal-row">
            <mat-checkbox [checked]="relAddSel()[i]" (change)="toggleRelAdd(i)"
              [attr.aria-label]="add.sourceEntityName + ' ' + labelFor(add.relationshipType) + ' ' + add.targetEntityName" />
            <div class="proposal-body">
              <div class="proposal-title">
                <span class="entity-chip">{{ add.sourceEntityName }}</span>
                <mat-icon class="arrow-icon">arrow_forward</mat-icon>
                <span class="rel-type-chip">{{ labelFor(add.relationshipType) }}</span>
                <mat-icon class="arrow-icon">arrow_forward</mat-icon>
                <span class="entity-chip">{{ add.targetEntityName }}</span>
              </div>
              @if (add.description) {
                <p class="event-description">{{ add.description }}</p>
              }
            </div>
          </div>
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="selectedCount() === 0" (click)="apply()">
        Apply {{ selectedCount() }} {{ selectedCount() === 1 ? 'change' : 'changes' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(560px, 90vw); box-sizing: border-box; }
    .intro { margin: 0 0 12px; color: var(--mat-sys-on-surface-variant, #49454f); font-size: 0.9rem; }
    .section-header {
      display: flex; align-items: center; gap: 8px;
      font-weight: 600; margin: 16px 0 8px;
      mat-icon { font-size: 20px; width: 20px; height: 20px; }
      &:first-of-type { margin-top: 0; }
    }
    .section-header--add { color: #2e7d32; }
    .section-header--update { color: #ad6800; }
    .section-header--remove { color: #b3261e; }
    .proposal-row {
      display: flex; align-items: flex-start; gap: 4px;
      padding: 8px; border-radius: 8px; margin-bottom: 6px;
      background: var(--mat-sys-surface-variant, #f3edf7);
    }
    .proposal-body { flex: 1; min-width: 0; padding-top: 8px; }
    .proposal-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .event-name { font-weight: 600; }
    .event-name--removed { text-decoration: line-through; }
    .entity-chip {
      font-size: 0.75rem; padding: 2px 8px; border-radius: 10px;
      background: var(--mat-sys-secondary-container, #e8def8);
      color: var(--mat-sys-on-secondary-container, #1d192b);
      white-space: nowrap;
    }
    .rel-type-chip {
      font-size: 0.75rem; padding: 2px 8px; border-radius: 10px;
      background: var(--mat-sys-tertiary-container, #ffd8e4);
      color: var(--mat-sys-on-tertiary-container, #31111d);
      white-space: nowrap; text-transform: capitalize; font-weight: 600;
    }
    .arrow-icon { font-size: 16px; width: 16px; height: 16px; color: var(--mat-sys-on-surface-variant, #49454f); }
    .event-timeframe { font-size: 0.8rem; font-style: italic; color: var(--mat-sys-on-surface-variant, #49454f); margin-top: 2px; }
    .event-location {
      display: flex; align-items: center; gap: 2px;
      font-size: 0.8rem; font-style: italic; color: var(--mat-sys-on-surface-variant, #49454f); margin-top: 2px;
    }
    .location-icon { font-size: 14px; width: 14px; height: 14px; flex-shrink: 0; }
    .location-entity-chip {
      display: inline-flex; align-items: center;
      padding: 1px 6px; border-radius: 8px; font-style: normal;
      background: var(--mat-sys-secondary-container, #e8def8);
      color: var(--mat-sys-on-secondary-container, #1d192b);
      font-size: 0.75rem; font-weight: 500;
    }
    .event-description { margin: 4px 0 0; font-size: 0.875rem; }
    .proposal-reason { font-size: 0.8rem; font-style: italic; color: var(--mat-sys-on-surface-variant, #49454f); margin-top: 2px; }
    .field-diffs { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
    .field-diff { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; flex-wrap: wrap; }
    .field-diff--stacked { flex-direction: column; align-items: flex-start; }
    .diff-arrow { font-size: 16px; width: 16px; height: 16px; color: var(--mat-sys-on-surface-variant, #49454f); }
    .diff-old { color: #b3261e; text-decoration: line-through; }
    .diff-new { color: #2e7d32; }
    .photo-section { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .photo-thumb-wrap {
      width: 56px; height: 56px; border-radius: 6px; overflow: hidden; flex-shrink: 0;
      background: var(--mat-sys-surface, #fffbfe);
    }
    .photo-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
    .photo-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .photo-btn { font-size: 0.8rem; height: 32px; line-height: 32px; padding: 0 10px;
      mat-icon { font-size: 16px; width: 16px; height: 16px; margin-right: 4px; }
    }
    .upload-spinner { display: inline-block; vertical-align: middle; }
  `],
})
export class ChapterAnalysisDialogComponent {
  private dialogRef = inject(MatDialogRef<ChapterAnalysisDialogComponent>);
  private dialog = inject(MatDialog);
  private entityService = inject(EntityService);
  readonly data = inject<ChapterAnalysisDialogData>(MAT_DIALOG_DATA);

  readonly tl = this.data.timeline;

  tlAddSel = signal<boolean[]>(this.tl.adds.map(() => true));
  tlUpdateSel = signal<boolean[]>(this.tl.updates.map(() => true));
  tlRemoveSel = signal<boolean[]>(this.tl.removes.map(() => true));
  relAddSel = signal<boolean[]>(this.data.relationships.adds.map(() => true));
  addPhotos = signal<(TimelineEventPhoto | null)[]>(this.tl.adds.map(() => null));
  uploadingAddIndex = signal<number | null>(null);

  private entityPhotosMap = signal<Record<string, EntityPhoto[]>>(
    Object.fromEntries(this.tl.entities.map(e => [e.id, e.photos ?? []])),
  );

  selectedCount = computed(() =>
    this.tlAddSel().filter(Boolean).length +
    this.tlUpdateSel().filter(Boolean).length +
    this.tlRemoveSel().filter(Boolean).length +
    this.relAddSel().filter(Boolean).length,
  );

  toggleTlAdd(i: number): void { this.tlAddSel.update(l => l.map((v, j) => j === i ? !v : v)); }
  toggleTlUpdate(i: number): void { this.tlUpdateSel.update(l => l.map((v, j) => j === i ? !v : v)); }
  toggleTlRemove(i: number): void { this.tlRemoveSel.update(l => l.map((v, j) => j === i ? !v : v)); }
  toggleRelAdd(i: number): void { this.relAddSel.update(l => l.map((v, j) => j === i ? !v : v)); }

  labelFor(type: string): string {
    return RELATIONSHIP_LABEL.get(type as never) ?? type;
  }

  pickPhotoForAdd(index: number): void {
    const entityId = this.tl.adds[index].entityId;
    const photos = this.entityPhotosMap()[entityId] ?? [];
    const ref = this.dialog.open(PhotoPickerDialogComponent, { data: photos, autoFocus: false });
    ref.afterClosed().subscribe((result?: PhotoPickerResult) => {
      if (result) this.addPhotos.update(l => l.map((p, i) => i === index ? result : p));
    });
  }

  onAddPhotoFileSelected(event: Event, index: number): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    const entityId = this.tl.adds[index].entityId;
    this.uploadingAddIndex.set(index);
    this.entityService.uploadThumbnail(file).subscribe({
      next: ({ url, thumbnailUrl }) => {
        this.entityService.addPhoto(entityId, url, thumbnailUrl).subscribe({
          next: updated => {
            this.entityPhotosMap.update(map => ({ ...map, [entityId]: updated.photos ?? [] }));
            this.addPhotos.update(l => l.map((p, i) => i === index ? { url, thumbnailUrl } : p));
            this.uploadingAddIndex.set(null);
          },
          error: () => this.uploadingAddIndex.set(null),
        });
      },
      error: () => this.uploadingAddIndex.set(null),
    });
  }

  clearAddPhoto(index: number): void {
    this.addPhotos.update(l => l.map((p, i) => i === index ? null : p));
  }

  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }

  apply(): void {
    const photos = this.addPhotos();
    const result: ChapterAnalysisDialogResult = {
      timeline: {
        adds: this.tl.adds
          .map((add, i) => ({ ...add, photo: photos[i] ?? undefined }))
          .filter((_, i) => this.tlAddSel()[i]),
        updates: this.tl.updates.filter((_, i) => this.tlUpdateSel()[i]),
        removes: this.tl.removes.filter((_, i) => this.tlRemoveSel()[i]),
      },
      relationships: {
        adds: this.data.relationships.adds.filter((_, i) => this.relAddSel()[i]),
      },
    };
    this.dialogRef.close(result);
  }
}
