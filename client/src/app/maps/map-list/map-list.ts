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
import { MapService } from '../map.service';
import { SeriesService } from '../../series/series.service';
import { SeriesContextService } from '../../services/series-context.service';
import { HeaderService } from '../../services/header.service';

@Component({
  selector: 'app-map-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatCardModule, MatProgressSpinnerModule, MatTooltipModule],
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
            </mat-card>
          }
        </div>
      }
    </div>

    <!-- Full-screen preview lightbox -->
    @if (previewMap()) {
      <div class="lightbox" role="dialog" [attr.aria-label]="previewMap()!.title + ' preview'"
           (click)="closePreview()">

        <!-- Floating action buttons — stop clicks reaching the backdrop -->
        <div class="lightbox-actions" (click)="$event.stopPropagation()">
          <span class="lightbox-map-title">{{ previewMap()!.title }}</span>
          <button mat-mini-fab (click)="edit(previewMap()!)" aria-label="Edit map" matTooltip="Edit map">
            <mat-icon>edit</mat-icon>
          </button>
          <button mat-mini-fab (click)="closePreview()" aria-label="Close preview" matTooltip="Close">
            <mat-icon>close</mat-icon>
          </button>
        </div>

        @if (previewMap()!.thumbnailUrl) {
          <img class="lightbox-img" [src]="proxyUrl(previewMap()!.thumbnailUrl!)"
               [alt]="previewMap()!.title" (click)="$event.stopPropagation()" />
        } @else {
          <div class="lightbox-placeholder" [style.background]="previewMap()!.background.color"
               (click)="$event.stopPropagation()">
            <mat-icon aria-hidden="true">map</mat-icon>
            <p>No preview yet — open the editor to generate one.</p>
          </div>
        }
      </div>
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
      overflow: hidden;
      transition: box-shadow 0.18s ease, transform 0.18s ease;

      &:hover { box-shadow: 0 6px 18px rgba(0,0,0,0.25); transform: translateY(-2px); }
      &:focus-visible { outline: 2px solid var(--mat-sys-primary); outline-offset: 2px; }
    }

    .map-card-thumb {
      height: 140px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;

      img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      mat-icon { font-size: 48px; width: 48px; height: 48px; color: rgba(255,255,255,0.85); }
    }

    /* Lightbox — full-screen with floating buttons */
    .lightbox {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: lb-in 0.18s ease;
    }

    @keyframes lb-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .lightbox-actions {
      position: absolute;
      top: 16px;
      right: 16px;
      z-index: 10;
      display: flex;
      align-items: center;
      gap: 8px;

      button {
        background: rgba(0, 0, 0, 0.55) !important;
        color: #fff !important;
        backdrop-filter: blur(4px);
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);

        mat-icon { color: #fff; }
      }
    }

    .lightbox-map-title {
      color: #fff;
      font-size: 0.9rem;
      font-weight: 500;
      text-shadow: 0 1px 4px rgba(0,0,0,0.7);
      padding: 0 4px;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .lightbox-img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      cursor: default;
    }

    .lightbox-placeholder {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: rgba(255,255,255,0.7);

      mat-icon { font-size: 64px; width: 64px; height: 64px; }
      p { margin: 0; font-size: 0.9rem; text-align: center; }
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

  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }
}
