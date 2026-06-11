import { Component, inject, signal, computed, OnInit, OnDestroy, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { forkJoin, Subscription } from 'rxjs';
import { Entity, EntityPhoto } from '@shared/models/entity.model';
import { Series } from '@shared/models/series.model';
import { EntityService } from '../services/entity.service';
import { SeriesService } from '../series/series.service';
import { HeaderService } from '../services/header.service';
import { SeriesContextService } from '../services/series-context.service';
import { UserSettingsService } from '../services/user-settings.service';

interface GalleryPhoto {
  entity: Entity;
  photo: EntityPhoto;
}

@Component({
  selector: 'app-photo-gallery',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './photo-gallery.html',
  styleUrl: './photo-gallery.scss',
})
export class PhotoGalleryComponent implements OnInit, OnDestroy {
  private entityService = inject(EntityService);
  private seriesService = inject(SeriesService);
  private headerService = inject(HeaderService);
  private seriesContext = inject(SeriesContextService);
  private settingsService = inject(UserSettingsService);

  loading = signal(false);
  allSeries = signal<Series[]>([]);
  allEntities = signal<Entity[]>([]);
  selectedSeriesId = signal<string | null>(null);
  selectedEntityIds = signal<string[]>([]);

  lightboxOpen = signal(false);
  lightboxIndex = signal(0);
  lightboxKey = signal(0);
  slideDir = signal<'next' | 'prev'>('next');
  slideshowActive = signal(false);
  private slideshowInterval: ReturnType<typeof setInterval> | null = null;
  private routeSub?: Subscription;
  private touchStartX = 0;

  /** Entities that have at least one visible photo */
  entitiesWithPhotos = computed(() => {
    const seriesId = this.selectedSeriesId();
    const entities = this.allEntities();
    const showHidden = this.settingsService.showHiddenPhotos();
    return entities
      .filter(e => !e.archived && !e.deleted)
      .filter(e => seriesId == null || e.seriesId === seriesId)
      .filter(e => {
        const visiblePhotos = (e.photos ?? []).filter(p => showHidden || !p.hidden);
        return visiblePhotos.length > 0 || e.thumbnailUrl;
      });
  });

  /** Flat list of all gallery photos after entity filter, excluding hidden photos when setting is off */
  galleryPhotos = computed<GalleryPhoto[]>(() => {
    const entityFilter = this.selectedEntityIds();
    const entities = this.entitiesWithPhotos();
    const showHidden = this.settingsService.showHiddenPhotos();
    const source = entityFilter.length > 0
      ? entities.filter(e => entityFilter.includes(e.id))
      : entities;

    const photos: GalleryPhoto[] = [];
    for (const entity of source) {
      if (entity.photos && entity.photos.length > 0) {
        for (const photo of entity.photos) {
          if (!showHidden && photo.hidden) continue;
          photos.push({ entity, photo });
        }
      } else if (entity.thumbnailUrl) {
        photos.push({
          entity,
          photo: { url: entity.originalUrl ?? entity.thumbnailUrl, thumbnailUrl: entity.thumbnailUrl },
        });
      }
    }
    return photos;
  });

  currentLightboxPhoto = computed(() => {
    const photos = this.galleryPhotos();
    const idx = this.lightboxIndex();
    return photos[idx] ?? null;
  });

  ngOnInit(): void {
    this.headerService.setPage('Photo Gallery');
    this.load();
  }

  ngOnDestroy(): void {
    this.stopSlideshow();
    this.routeSub?.unsubscribe();
  }

  load(): void {
    this.loading.set(true);
    forkJoin({
      series: this.seriesService.getAll(),
      entities: this.entityService.getAll(),
    }).subscribe({
      next: ({ series, entities }) => {
        this.allSeries.set(series);
        this.allEntities.set(entities);

        // Pre-select series from context if available
        const contextId = this.seriesContext.currentSeriesId();
        if (contextId && series.some(s => s.id === contextId)) {
          this.selectedSeriesId.set(contextId);
        }

        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  onSeriesChange(seriesId: string | null): void {
    this.selectedSeriesId.set(seriesId ?? null);
    this.selectedEntityIds.set([]);
    this.closeLightbox();
  }

  onEntityFilterChange(ids: string[]): void {
    this.selectedEntityIds.set(ids ?? []);
    this.lightboxIndex.set(0);
  }

  // ── Lightbox ──────────────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  onDocumentKey(event: KeyboardEvent): void {
    if (!this.lightboxOpen()) return;
    if (event.key === 'ArrowLeft')  { this.prevPhoto(); event.preventDefault(); }
    if (event.key === 'ArrowRight') { this.nextPhoto(); event.preventDefault(); }
    if (event.key === 'Escape')     { this.closeLightbox(); event.preventDefault(); }
  }

  onLightboxKey(event: KeyboardEvent): void {
    // handled by document listener above
  }

  onTouchStart(event: TouchEvent): void {
    this.touchStartX = event.changedTouches[0].clientX;
  }

  onTouchEnd(event: TouchEvent): void {
    const delta = event.changedTouches[0].clientX - this.touchStartX;
    if (Math.abs(delta) < 40) return; // ignore taps
    if (delta < 0) this.nextPhoto();
    else           this.prevPhoto();
  }

  openLightbox(index: number): void {
    this.lightboxIndex.set(index);
    this.lightboxOpen.set(true);
  }

  closeLightbox(): void {
    this.lightboxOpen.set(false);
    this.stopSlideshow();
  }

  prevPhoto(): void {
    const photos = this.galleryPhotos();
    if (photos.length === 0) return;
    this.slideDir.set('prev');
    this.lightboxIndex.update(i => (i - 1 + photos.length) % photos.length);
    this.lightboxKey.update(k => k + 1);
  }

  nextPhoto(): void {
    const photos = this.galleryPhotos();
    if (photos.length === 0) return;
    this.slideDir.set('next');
    this.lightboxIndex.update(i => (i + 1) % photos.length);
    this.lightboxKey.update(k => k + 1);
  }

  // ── Slideshow ─────────────────────────────────────────────────────────────

  toggleSlideshow(): void {
    if (this.slideshowActive()) {
      this.stopSlideshow();
    } else {
      this.startSlideshow();
    }
  }

  private startSlideshow(): void {
    if (!this.lightboxOpen()) {
      this.openLightbox(0);
    }
    this.slideshowActive.set(true);
    this.slideshowInterval = setInterval(() => {
      this.nextPhoto();
    }, 3000);
  }

  private stopSlideshow(): void {
    this.slideshowActive.set(false);
    if (this.slideshowInterval !== null) {
      clearInterval(this.slideshowInterval);
      this.slideshowInterval = null;
    }
  }

  proxyUrl(url: string | undefined | null): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }
}
