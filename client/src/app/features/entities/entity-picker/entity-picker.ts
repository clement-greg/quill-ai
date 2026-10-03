import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { Entity } from '@shared/models/entity.model';
import { Series } from '@shared/models/series.model';
import { SeriesService } from '@app/features/series/series.service';
import { SeriesContextService } from '@app/core/services/series-context.service';
import { EntityService } from '../entity.service';

/** The entity a picker has landed on. */
export interface EntityPick {
  id: string;
  name: string;
  /** The entity's profile picture, as stored — show it through entityImageSrc(). */
  thumbnailUrl?: string;
}

/** A stored image url as the browser fetches it: through the server's decrypting proxy. */
export function entityImageSrc(url: string | undefined): string | null {
  const filename = url?.split('/').pop();
  return filename ? `/api/image/${filename}` : null;
}

/**
 * Picks one entity: a series dropdown to scope the list, a name search, and the
 * matching entities. Starts on `seriesId` when given, else the series the user
 * was last working in, else the first one.
 */
@Component({
  selector: 'app-entity-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatFormFieldModule, MatIconModule, MatInputModule, MatProgressSpinnerModule, MatSelectModule],
  template: `
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

    <div class="entity-list" role="listbox" [attr.aria-label]="label()">
      @if (loading()) {
        <div class="list-state"><mat-spinner diameter="28"></mat-spinner></div>
      } @else if (filteredEntities().length === 0) {
        <p class="list-state">{{ seriesId() ? 'No entities match.' : 'Choose a series.' }}</p>
      } @else {
        @for (e of filteredEntities(); track e.id) {
          <button type="button" class="entity-row"
                  role="option"
                  [class.entity-row--selected]="selected()?.id === e.id"
                  [attr.aria-selected]="selected()?.id === e.id"
                  (click)="pick(e)">
            @if (e.thumbnailUrl) {
              <img class="entity-thumb" [src]="proxyUrl(e.thumbnailUrl)" alt="" />
            } @else {
              <span class="entity-thumb entity-thumb--empty"><mat-icon>person</mat-icon></span>
            }
            <span class="entity-name">{{ e.name }}</span>
            <span class="entity-type">{{ typeLabel(e.type) }}</span>
          </button>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .field { width: 100%; }
    .entity-list {
      max-height: 30vh; overflow-y: auto; border: 1px solid rgba(128, 128, 128, 0.3);
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
export class EntityPickerComponent implements OnInit {
  private entityService = inject(EntityService);
  private seriesService = inject(SeriesService);
  private seriesContext = inject(SeriesContextService);

  /** Series to start on; falls back to the one in context. */
  readonly initialSeriesId = input<string | null>(null);
  /** Accessible name for the list. */
  readonly label = input('Entity');
  readonly selected = model<EntityPick | null>(null);

  series = signal<Series[]>([]);
  entities = signal<Entity[]>([]);
  seriesId = signal<string | null>(null);
  search = signal('');
  loading = signal(false);

  readonly filteredEntities = computed(() => {
    const term = this.search().trim().toLowerCase();
    const live = this.entities().filter(e => !e.archived && !e.deleted);
    return term ? live.filter(e => e.name.toLowerCase().includes(term)) : live;
  });

  ngOnInit(): void {
    this.seriesService.getAll().subscribe({
      next: all => {
        const series = all.filter(s => !s.archived && !s.deleted);
        this.series.set(series);
        const wanted = this.initialSeriesId() ?? this.seriesContext.currentSeriesId();
        const start = series.find(s => s.id === wanted)?.id ?? series[0]?.id ?? null;
        if (start) this.onSeriesChange(start);
      },
    });
  }

  onSeriesChange(seriesId: string): void {
    if (seriesId === this.seriesId()) return;
    this.seriesId.set(seriesId);
    // A pick from the previous series is no longer on screen; keeping it would
    // let the caller act on an entity the user can't see.
    this.selected.set(null);
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

  pick(entity: Entity): void {
    this.selected.set({
      id: entity.id,
      name: entity.name,
      ...(entity.thumbnailUrl ? { thumbnailUrl: entity.thumbnailUrl } : {}),
    });
  }

  proxyUrl(url: string): string | null {
    return entityImageSrc(url);
  }

  typeLabel(type: string): string {
    return type.charAt(0) + type.slice(1).toLowerCase();
  }
}
