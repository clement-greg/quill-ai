import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Entity } from '@shared/models/entity.model';
import { EntityService } from '../services/entity.service';

export interface EntityPickerData {
  seriesId: string | null;
}

/**
 * Lets the user pick one entity (character / place / thing) from a series, used
 * when saving a generated image into that entity's photo gallery. Closes with
 * the chosen Entity, or undefined on cancel.
 */
@Component({
  selector: 'app-entity-picker-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>Save to gallery</h2>
    <mat-dialog-content>
      @if (loading()) {
        <div class="loading-row"><mat-spinner diameter="20"></mat-spinner><span>Loading…</span></div>
      } @else if (entities().length === 0) {
        <p class="empty">There are no entities yet to save the image into.</p>
      } @else {
        <mat-form-field appearance="outline" class="search">
          <mat-label>Search entities</mat-label>
          <input matInput [ngModel]="query()" (ngModelChange)="query.set($event)"
                 placeholder="Filter by name…" />
        </mat-form-field>

        <div class="list" role="listbox" aria-label="Entities">
          @for (e of filtered(); track e.id) {
            <button type="button" class="row" role="option"
                    [class.selected]="selectedId() === e.id"
                    [attr.aria-selected]="selectedId() === e.id"
                    (click)="selectedId.set(e.id)"
                    (dblclick)="confirm(e)">
              <mat-icon class="row-icon">{{ icon(e.type) }}</mat-icon>
              <span class="row-name">{{ e.name }}</span>
              <span class="row-type">{{ typeLabel(e.type) }}</span>
            </button>
          } @empty {
            <div class="list-empty">No entities match “{{ query() }}”.</div>
          }
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!selectedId()" (click)="confirmSelected()">Save here</button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { width: min(460px, 92vw); box-sizing: border-box; }
    .search { width: 100%; }
    .loading-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
    .empty { color: var(--mat-sys-on-surface-variant); }
    .list {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 10px;
      min-height: 160px;
      max-height: 300px;
      overflow-y: auto;
      padding: 4px;
    }
    .list-empty { padding: 16px; color: var(--mat-sys-on-surface-variant); font-size: 0.88rem; }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      border: none;
      background: none;
      text-align: left;
      cursor: pointer;
      padding: 8px 10px;
      border-radius: 8px;
      font: inherit;
      color: var(--mat-sys-on-surface);
    }
    .row:hover { background: var(--mat-sys-surface-container-high); }
    .row.selected { background: var(--mat-sys-primary-container); color: var(--mat-sys-on-primary-container); }
    .row-icon { color: var(--mat-sys-primary); }
    .row.selected .row-icon { color: inherit; }
    .row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-type { font-size: 0.78rem; color: var(--mat-sys-on-surface-variant); text-transform: capitalize; }
    .row.selected .row-type { color: inherit; }
  `],
})
export class EntityPickerDialogComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<EntityPickerDialogComponent, Entity>);
  private readonly data = inject<EntityPickerData>(MAT_DIALOG_DATA);
  private readonly entityService = inject(EntityService);

  readonly loading = signal(true);
  readonly entities = signal<Entity[]>([]);
  readonly query = signal('');
  readonly selectedId = signal<string | null>(null);

  readonly filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    const list = this.entities();
    if (!q) return list;
    return list.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.nickname?.toLowerCase().includes(q) ||
      e.firstName?.toLowerCase().includes(q) ||
      e.lastName?.toLowerCase().includes(q) ||
      e.aliases?.some(a => a.toLowerCase().includes(q)),
    );
  });

  ngOnInit(): void {
    const seriesId = this.data.seriesId;
    // A series scopes the list; without one (e.g. the cross-series quick chat),
    // fall back to every entity the user owns.
    const source$ = seriesId
      ? this.entityService.getBySeries(seriesId)
      : this.entityService.getAll();
    source$.subscribe({
      next: list => {
        this.entities.set(
          list
            .filter(e => !e.archived && !e.deleted)
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  icon(type: Entity['type']): string {
    return type === 'PERSON' ? 'person' : type === 'PLACE' ? 'place' : 'category';
  }

  typeLabel(type: Entity['type']): string {
    return type.charAt(0) + type.slice(1).toLowerCase();
  }

  confirmSelected(): void {
    const entity = this.entities().find(e => e.id === this.selectedId());
    if (entity) this.confirm(entity);
  }

  confirm(entity: Entity): void {
    this.dialogRef.close(entity);
  }
}
