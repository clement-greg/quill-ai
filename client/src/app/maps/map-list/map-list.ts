import {
  Component, ChangeDetectionStrategy, OnInit, OnDestroy,
  inject, signal, HostListener,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, forkJoin } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { SeriesMap } from '@shared/models/map.model';
import { MapPreviewComponent } from '../map-preview/map-preview';
import { MapService } from '../map.service';
import { SeriesService } from '../../series/series.service';
import { SeriesContextService } from '../../services/series-context.service';
import { HeaderService } from '../../services/header.service';

@Component({
  selector: 'app-map-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatCardModule, MatProgressSpinnerModule, MatTooltipModule, MapPreviewComponent],
  template: `
    <div class="container">
      <div class="list-header">
        <h2>Maps</h2>
        <button mat-flat-button (click)="createMap()" [disabled]="!seriesId() || creating()" aria-label="New map">
          <mat-icon>add</mat-icon><span> New map</span>
        </button>
      </div>

      @if (loading()) {
        <div class="state"><mat-spinner diameter="32" /></div>
      } @else if (!seriesId()) {
        <p class="empty-hint">Open a series first to build maps for its world.</p>
      } @else if (maps().length === 0) {
        <p class="empty-hint">No maps yet. Create one to start charting your world.</p>
      } @else {
        <div class="maps-grid" role="list">
          @for (map of maps(); track map.id) {
            <mat-card class="map-card" role="listitem" tabindex="0"
                      (click)="preview(map)"
                      (keydown.enter)="preview(map)"
                      (keydown.space)="preview(map)"
                      [attr.aria-label]="'Preview map ' + map.title">
              <div class="map-card-thumb" [style.background]="map.background.color">
                @if (map.thumbnailUrl) {
                  <img [src]="proxyUrl(map.thumbnailUrl)" [alt]="map.title + ' preview'" loading="lazy" />
                } @else {
                  <mat-icon aria-hidden="true">map</mat-icon>
                }
              </div>
              <mat-card-header>
                <mat-card-title>{{ map.title }}</mat-card-title>
                <mat-card-subtitle>
                  {{ map.elements.length }} {{ map.elements.length === 1 ? 'element' : 'elements' }}
                </mat-card-subtitle>
              </mat-card-header>
              <button class="card-delete"
                      [class.card-delete--armed]="pendingDeleteId() === map.id"
                      (click)="requestDelete($event, map.id)"
                      [attr.aria-label]="pendingDeleteId() === map.id ? 'Confirm delete ' + map.title : 'Delete ' + map.title"
                      [matTooltip]="pendingDeleteId() === map.id ? 'Click again to confirm' : 'Delete map'"
                      type="button">
                <mat-icon aria-hidden="true">{{ pendingDeleteId() === map.id ? 'warning' : 'delete' }}</mat-icon>
              </button>
            </mat-card>
          }
        </div>
      }
    </div>

    <!-- Full-screen read-only preview -->
    @if (previewMap(); as map) {
      <app-map-preview
        [title]="map.title"
        [thumbnailUrl]="map.thumbnailUrl"
        [placeholderColor]="map.background.color"
        (edit)="edit(map)"
        (closed)="closePreview()" />
    }
  `,
  styles: `
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .list-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    h2 { margin: 0; }
    .state { display: flex; justify-content: center; padding: 48px; }
    .empty-hint { color: var(--mat-sys-on-surface-variant); padding: 24px 0; }

    .maps-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 16px;
    }

    .map-card {
      cursor: pointer;
      overflow: visible;
      position: relative;
      transition: box-shadow 0.18s ease, transform 0.18s ease;

      &:hover { box-shadow: 0 6px 18px rgba(0,0,0,0.25); transform: translateY(-2px); }
      &:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: 2px; }

      .card-delete {
        display: none;
        position: absolute;
        top: -8px;
        right: -8px;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: rgba(0,0,0,0.55);
        color: #fff;
        cursor: pointer;
        align-items: center;
        justify-content: center;
        z-index: 2;
        transition: background 0.15s;

        mat-icon { font-size: 16px; width: 16px; height: 16px; line-height: 16px; }

        &--armed {
          display: flex;
          background: var(--mat-sys-error, #b3261e);
          animation: armed-pulse 0.6s ease infinite alternate;
        }

        &:hover { background: var(--mat-sys-error, #b3261e); }
        &:focus-visible { outline: 2px solid var(--mat-sys-primary); display: flex; }
      }

      &:hover .card-delete { display: flex; }
    }

    @keyframes armed-pulse {
      from { box-shadow: 0 0 0 0 rgba(179,38,30,0.6); }
      to   { box-shadow: 0 0 0 6px rgba(179,38,30,0); }
    }

    .map-card-thumb {
      height: 140px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
      border-radius: 12px 12px 0 0;

      img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      mat-icon { font-size: 48px; width: 48px; height: 48px; color: rgba(255,255,255,0.85); }
    }
  `,
})
export class MapListComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private mapService = inject(MapService);
  private seriesService = inject(SeriesService);
  private seriesContext = inject(SeriesContextService);
  private headerService = inject(HeaderService);
  private sub?: Subscription;

  readonly seriesId = signal<string | null>(null);
  readonly maps = signal<SeriesMap[]>([]);
  readonly loading = signal(true);
  readonly creating = signal(false);
  readonly previewMap = signal<SeriesMap | null>(null);
  readonly pendingDeleteId = signal<string | null>(null);
  private deleteConfirmTimer?: ReturnType<typeof setTimeout>;

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.previewMap()) this.closePreview();
  }

  ngOnInit(): void {
    this.sub = this.route.paramMap.subscribe(params => {
      const routeId = params.get('seriesId');
      if (routeId) {
        this.seriesContext.set(routeId);
        this.seriesId.set(routeId);
        this.load(routeId);
      } else {
        const lastSeriesId = this.seriesContext.currentSeriesId();
        if (lastSeriesId) {
          this.router.navigate(['/series', lastSeriesId, 'maps']);
          return;
        }
        this.seriesId.set(null);
        this.loading.set(false);
        this.headerService.setPage('Maps');
      }
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.headerService.clearAll();
    clearTimeout(this.deleteConfirmTimer);
  }

  private load(seriesId: string): void {
    this.loading.set(true);
    forkJoin({
      maps: this.mapService.getBySeries(seriesId),
      series: this.seriesService.getById(seriesId),
    }).subscribe({
      next: ({ maps, series }) => {
        this.maps.set(maps.sort((a, b) => a.title.localeCompare(b.title)));
        this.loading.set(false);
        this.headerService.set([
          { label: series.title, link: '/series/' + series.id },
          { label: 'Maps' },
        ]);
      },
      error: () => this.loading.set(false),
    });
  }

  createMap(): void {
    const seriesId = this.seriesId();
    if (!seriesId || this.creating()) return;
    this.creating.set(true);
    const map: SeriesMap = {
      id: uuidv4(),
      seriesId,
      title: 'Untitled Map',
      width: 2000,
      height: 1400,
      background: { kind: 'color', color: '#e8dcc0', gridSize: 50, gridColor: 'rgba(0,0,0,0.06)' },
      elements: [],
    };
    this.mapService.create(map).subscribe({
      next: created => this.router.navigate(['/maps', created.id]),
      error: () => this.creating.set(false),
    });
  }

  preview(map: SeriesMap): void {
    this.previewMap.set(map);
  }

  closePreview(): void {
    this.previewMap.set(null);
  }

  edit(map: SeriesMap): void {
    this.router.navigate(['/maps', map.id]);
  }

  requestDelete(event: Event, mapId: string): void {
    event.stopPropagation();
    if (this.pendingDeleteId() === mapId) {
      // Second click — confirmed
      clearTimeout(this.deleteConfirmTimer);
      this.pendingDeleteId.set(null);
      this.mapService.delete(mapId).subscribe({
        next: () => this.maps.update(list => list.filter(m => m.id !== mapId)),
      });
    } else {
      // First click — arm the confirmation, auto-cancel after 3 s
      this.pendingDeleteId.set(mapId);
      clearTimeout(this.deleteConfirmTimer);
      this.deleteConfirmTimer = setTimeout(() => this.pendingDeleteId.set(null), 3000);
    }
  }

  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }
}
