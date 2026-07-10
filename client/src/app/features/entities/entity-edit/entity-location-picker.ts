import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  computed,
  effect,
  untracked,
  inject,
  OnDestroy,
  viewChild,
  ElementRef,
  NgZone,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { EntityLocation } from '@shared/models/entity.model';
import { SeriesMap } from '@shared/models/map.model';
import { MapService } from '@app/features/maps/map.service';
import { loadGoogleMaps } from '@app/core/utils/google-maps-loader';

@Component({
  selector: 'app-entity-location-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatSelectModule,
    MatInputModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './entity-location-picker.html',
  styleUrl: './entity-location-picker.scss',
})
export class EntityLocationPickerComponent implements OnDestroy {
  private zone = inject(NgZone);
  private mapService = inject(MapService);

  entityId = input.required<string>();
  seriesId = input.required<string>();
  location = input<EntityLocation | undefined>(undefined);
  locationChange = output<EntityLocation | undefined>();

  readonly locationType = signal<'none' | 'real-world' | 'fictional'>('none');

  // Fictional map state
  readonly seriesMaps = signal<SeriesMap[]>([]);
  readonly mapsLoading = signal(false);
  readonly selectedMapId = signal<string | null>(null);
  readonly selectedMap = computed(() =>
    this.seriesMaps().find(m => m.id === this.selectedMapId()) ?? null
  );
  readonly fictionalPin = signal<{ x: number; y: number } | null>(null);

  // Real-world state
  readonly realWorldCoords = signal<{ lat: number; lng: number } | null>(null);
  readonly addressInput = signal('');
  readonly geocoding = signal(false);
  readonly geocodeError = signal<string | null>(null);
  readonly mapReady = signal(false);
  readonly mapLoadError = signal(false);

  readonly mapEl = viewChild<ElementRef<HTMLDivElement>>('mapEl');

  private gmaps: typeof google.maps | undefined;
  private gmap: google.maps.Map | undefined;
  private geocoder: google.maps.Geocoder | undefined;
  private gmarker: google.maps.Marker | null = null;
  private lastMapEl: HTMLDivElement | null = null;
  private lastEntityId = '';
  private destroyed = false;

  constructor() {
    // Reset internal state when a different entity is loaded
    effect(() => {
      const id = this.entityId();
      const loc = this.location();
      untracked(() => {
        if (id === this.lastEntityId) return;
        this.lastEntityId = id;
        this.initFromLocation(loc);
      });
    }, { allowSignalWrites: true });

    // Load series maps
    effect(() => {
      const seriesId = this.seriesId();
      if (!seriesId) return;
      untracked(() => {
        this.mapsLoading.set(true);
        this.mapService.getBySeries(seriesId).subscribe({
          next: maps => {
            this.zone.run(() => {
              this.seriesMaps.set(maps.filter(m => !m.archived));
              this.mapsLoading.set(false);
            });
          },
          error: () => this.zone.run(() => this.mapsLoading.set(false)),
        });
      });
    });

    // Initialize Google Map when the real-world container enters the DOM
    effect(() => {
      if (this.locationType() !== 'real-world') return;
      const el = this.mapEl()?.nativeElement;
      if (!el || el === this.lastMapEl) return;
      this.zone.runOutsideAngular(() => void this.initGoogleMap(el));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.gmarker?.setMap(null);
    this.gmap = undefined;
  }

  private initFromLocation(loc: EntityLocation | undefined): void {
    if (loc?.type === 'real-world') {
      this.locationType.set('real-world');
      this.realWorldCoords.set(
        loc.realWorld ? { lat: loc.realWorld.lat, lng: loc.realWorld.lng } : null
      );
      this.addressInput.set(loc.realWorld?.address ?? '');
    } else if (loc?.type === 'fictional') {
      this.locationType.set('fictional');
      this.selectedMapId.set(loc.fictional?.mapId ?? null);
      this.fictionalPin.set(
        loc.fictional ? { x: loc.fictional.x, y: loc.fictional.y } : null
      );
    } else {
      this.locationType.set('none');
      this.realWorldCoords.set(null);
      this.addressInput.set('');
      this.selectedMapId.set(null);
      this.fictionalPin.set(null);
    }
  }

  setLocationType(type: 'none' | 'real-world' | 'fictional'): void {
    this.locationType.set(type);
    if (type === 'none') {
      this.locationChange.emit(undefined);
    }
  }

  // ── Fictional map ──────────────────────────────────────────

  onFictionalMapSelect(mapId: string): void {
    this.selectedMapId.set(mapId);
    this.fictionalPin.set(null);
    this.locationChange.emit(undefined);
  }

  onMapCanvasClick(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const relX = (event.clientX - rect.left) / rect.width;
    const relY = (event.clientY - rect.top) / rect.height;
    const map = this.selectedMap();
    if (!map) return;
    const x = Math.round(Math.max(0, Math.min(1, relX)) * map.width);
    const y = Math.round(Math.max(0, Math.min(1, relY)) * map.height);
    this.fictionalPin.set({ x, y });
    this.locationChange.emit({
      type: 'fictional',
      fictional: { mapId: map.id, x, y },
    });
  }

  clearFictionalPin(): void {
    this.fictionalPin.set(null);
    this.locationChange.emit(undefined);
  }

  // ── Real-world map ─────────────────────────────────────────

  private async initGoogleMap(el: HTMLDivElement): Promise<void> {
    if (this.destroyed || !el.isConnected) return;
    this.lastMapEl = el;

    if (this.gmarker) { this.gmarker.setMap(null); this.gmarker = null; }
    this.gmap = undefined;
    this.gmaps = undefined;
    this.geocoder = undefined;
    this.zone.run(() => { this.mapReady.set(false); this.mapLoadError.set(false); });

    try {
      this.gmaps = await loadGoogleMaps();
      if (this.destroyed || !el.isConnected) return;

      this.gmap = new this.gmaps.Map(el, {
        center: { lat: 20, lng: 0 },
        zoom: 2,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
      this.geocoder = new this.gmaps.Geocoder();

      this.gmap.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const lat = e.latLng.lat();
        const lng = e.latLng.lng();
        this.zone.run(() => {
          this.realWorldCoords.set({ lat, lng });
          this.setRealWorldMarker({ lat, lng });
          this.locationChange.emit({
            type: 'real-world',
            realWorld: { lat, lng, address: this.addressInput() || undefined },
          });
        });
      });

      const existing = this.realWorldCoords();
      if (existing) {
        this.setRealWorldMarker(existing);
        this.gmap.setCenter(existing);
        this.gmap.setZoom(12);
      }

      this.zone.run(() => this.mapReady.set(true));
    } catch {
      this.zone.run(() => this.mapLoadError.set(true));
    }
  }

  searchAddress(): void {
    const address = this.addressInput().trim();
    if (!address || !this.geocoder || this.geocoding()) return;
    this.geocoding.set(true);
    this.geocodeError.set(null);
    this.geocoder.geocode({ address }, (results, status) => {
      this.zone.run(() => {
        this.geocoding.set(false);
        if (status === 'OK' && results?.[0]) {
          const loc = results[0].geometry.location;
          const coords = { lat: loc.lat(), lng: loc.lng() };
          this.realWorldCoords.set(coords);
          this.setRealWorldMarker(coords);
          this.gmap?.setCenter(coords);
          this.gmap?.setZoom(12);
          this.locationChange.emit({
            type: 'real-world',
            realWorld: { ...coords, address },
          });
        } else {
          this.geocodeError.set(status);
        }
      });
    });
  }

  clearRealWorldLocation(): void {
    this.realWorldCoords.set(null);
    this.geocodeError.set(null);
    this.gmarker?.setMap(null);
    this.gmarker = null;
    this.locationChange.emit(undefined);
    this.gmap?.setCenter({ lat: 20, lng: 0 });
    this.gmap?.setZoom(2);
  }

  private setRealWorldMarker(coords: { lat: number; lng: number }): void {
    if (!this.gmaps || !this.gmap) return;
    if (this.gmarker) {
      this.gmarker.setPosition(coords);
    } else {
      this.gmarker = new this.gmaps.Marker({ position: coords, map: this.gmap });
    }
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  formatCoord(n: number): string {
    return n.toFixed(5);
  }
}
