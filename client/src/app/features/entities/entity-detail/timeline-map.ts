import {
  Component,
  inject,
  input,
  output,
  signal,
  computed,
  effect,
  afterNextRender,
  OnDestroy,
  ChangeDetectionStrategy,
  viewChild,
  ElementRef,
  NgZone,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { TimelineEvent } from '@shared/models/timeline-event.model';
import { Entity } from '@shared/models/entity.model';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { loadGoogleMaps } from '@app/core/utils/google-maps-loader';

const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#212121' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#212121' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#757575' }] },
  { featureType: 'administrative.country', elementType: 'labels.text.fill', stylers: [{ color: '#9e9e9e' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#bdbdbd' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#181818' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { featureType: 'poi.park', elementType: 'labels.text.stroke', stylers: [{ color: '#1b1b1b' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#2c2c2c' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
  { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#373737' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3c3c3c' }] },
  { featureType: 'road.highway.controlled_access', elementType: 'geometry', stylers: [{ color: '#4e4e4e' }] },
  { featureType: 'road.local', elementType: 'labels.text.fill', stylers: [{ color: '#616161' }] },
  { featureType: 'transit', elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#000000' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#3d3d3d' }] },
];


@Component({
  selector: 'app-timeline-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: block' },
  imports: [MatProgressSpinnerModule, MatIconModule, MatButtonModule],
  template: `
    <div class="map-shell" [class.map-shell--expanded]="isExpanded()">
      <div #mapEl class="map-el" role="region" aria-label="Timeline event map"></div>

      <button
        mat-icon-button
        class="map-expand-btn"
        (click)="toggleExpanded()"
        [attr.aria-label]="isExpanded() ? 'Collapse map' : 'Expand map'"
        [attr.aria-pressed]="isExpanded()">
        <mat-icon>{{ isExpanded() ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
      </button>

      @if (geocodingRemaining() > 0) {
        <div class="map-status" aria-live="polite" aria-atomic="true">
          <mat-spinner diameter="14" />
          Locating {{ geocodingRemaining() }}
          {{ geocodingRemaining() === 1 ? 'event' : 'events' }}&hellip;
        </div>
      }

      @if (loadError()) {
        <div class="map-empty">
          <mat-icon aria-hidden="true">error_outline</mat-icon>
          <p>The map couldn't be loaded. Check the network connection and try again.</p>
        </div>
      } @else if (geocodeError(); as err) {
        <div class="map-empty">
          <mat-icon aria-hidden="true">error_outline</mat-icon>
          <p>
            Geocoding failed ({{ err }}). Make sure the <strong>Geocoding API</strong>
            is enabled for this key in Google Cloud Console and that the key's
            API restrictions allow it.
          </p>
        </div>
      } @else if (ready() && pinCount() === 0) {
        <div class="map-empty">
          <mat-icon aria-hidden="true">public_off</mat-icon>
          <p>
            @if (hasLocations()) {
              None of the locations matched a real-world place — fictitious locations can&apos;t be mapped.
            } @else {
              Add a location to timeline events to see them here.
            }
          </p>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .map-shell {
      position: relative;
      height: 360px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--mat-sys-outline-variant, #cac4d0);
    }
    .map-el { width: 100%; height: 100%; }
    .map-status {
      position: absolute;
      bottom: 12px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.65);
      color: #fff;
      border-radius: 20px;
      padding: 5px 14px;
      font-size: 0.8rem;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      pointer-events: none;
      z-index: 2;
    }
    .map-empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--mat-sys-on-surface-variant, #49454f);
      background: var(--mat-sys-surface-variant, #f3edf7);
      padding: 24px;
      text-align: center;
      z-index: 1;
      mat-icon { font-size: 40px; width: 40px; height: 40px; opacity: 0.5; }
      p { margin: 0; font-size: 0.9rem; max-width: 280px; }
    }
    .map-expand-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 3;
      background: rgba(255, 255, 255, 0.85);
      backdrop-filter: blur(4px);
      color: #444;
      width: 32px;
      height: 32px;
      line-height: 32px;
      mat-icon { font-size: 20px; width: 20px; height: 20px; line-height: 20px; }
      &:hover { background: rgba(255, 255, 255, 1); }
    }
    :host-context([data-theme='dark']) .map-expand-btn,
    :host-context(.dark) .map-expand-btn {
      background: rgba(40, 40, 40, 0.85);
      color: #ddd;
      &:hover { background: rgba(50, 50, 50, 1); }
    }
    .map-shell--expanded {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      border-radius: 0;
      border: none;
      z-index: 1000;
    }
  `],
})
export class TimelineMapComponent implements OnDestroy {
  private zone = inject(NgZone);
  private settings = inject(UserSettingsService);

  events = input<TimelineEvent[]>([]);
  /** Resolved PLACE entities keyed by ID — used to bypass geocoding for real-world-linked events. */
  locationEntities = input<Map<string, Entity>>(new Map());
  eventHovered = output<string | null>();

  geocodingRemaining = signal(0);
  pinCount = signal(0);
  ready = signal(false);
  loadError = signal(false);
  geocodeError = signal<string | null>(null);
  hasLocations = computed(() => this.events().some(e => e.location?.trim()));

  isExpanded = signal(false);

  private maps: typeof google.maps | undefined;
  private map: google.maps.Map | undefined;
  private geocoder: google.maps.Geocoder | undefined;
  private infoWindow: google.maps.InfoWindow | undefined;
  private hoverInfoWindow: google.maps.InfoWindow | undefined;
  private markers: google.maps.Marker[] = [];
  private loadToken = 0;
  private destroyed = false;
  private geocodeCache = new Map<string, google.maps.LatLngLiteral | null>();
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.isExpanded()) {
      this.zone.run(() => this.collapse());
    }
  };

  readonly mapEl = viewChild<ElementRef<HTMLDivElement>>('mapEl');

  constructor() {
    afterNextRender(() => {
      document.addEventListener('keydown', this.onKeyDown);
      this.zone.runOutsideAngular(() => void this.setup());
    });

    // Reload markers whenever events or resolved location entities change.
    effect(() => {
      this.events();
      this.locationEntities();
      if (!this.ready() || !this.maps || !this.map) return;
      this.zone.runOutsideAngular(() => void this.loadMarkers(this.maps!));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.infoWindow?.close();
    this.hoverInfoWindow?.close();
    this.clearMarkers();
    this.map = undefined;
    document.removeEventListener('keydown', this.onKeyDown);
    if (this.isExpanded()) {
      document.body.style.overflow = '';
    }
  }

  /** Call when the containing tab becomes active so the map re-sizes to fill its container. */
  onTabActivated(): void {
    if (this.map) {
      setTimeout(() => google.maps.event.trigger(this.map!, 'resize'), 0);
    }
  }

  toggleExpanded(): void {
    if (this.isExpanded()) {
      this.collapse();
    } else {
      this.isExpanded.set(true);
      document.body.style.overflow = 'hidden';
      setTimeout(() => google.maps.event.trigger(this.map!, 'resize'), 0);
    }
  }

  private collapse(): void {
    this.isExpanded.set(false);
    document.body.style.overflow = '';
    setTimeout(() => google.maps.event.trigger(this.map!, 'resize'), 0);
  }

  private async setup(): Promise<void> {
    const el = this.mapEl()?.nativeElement;
    if (!el) return;

    let maps: typeof google.maps;
    try {
      maps = await loadGoogleMaps();
    } catch {
      this.zone.run(() => this.loadError.set(true));
      return;
    }
    if (this.destroyed || !el.isConnected) return;

    const isDark = this.settings.darkMode();
    this.map = new maps.Map(el, {
      center: { lat: 20, lng: 0 },
      zoom: 2,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      ...(isDark ? { styles: DARK_MAP_STYLES } : {}),
    });
    this.maps = maps;
    this.geocoder = new maps.Geocoder();
    this.infoWindow = new maps.InfoWindow();
    this.hoverInfoWindow = new maps.InfoWindow({ disableAutoPan: true });
    this.hoverInfoWindow.addListener('domready', () => {
      const btn = document.querySelector('.gm-ui-hover-effect') as HTMLElement | null;
      if (btn) btn.style.display = 'none';
    });
    // Flipping ready triggers the effect, which performs the initial marker load.
    this.zone.run(() => this.ready.set(true));
  }

  private async loadMarkers(maps: typeof google.maps): Promise<void> {
    // Cancel any in-flight load (e.g. rapid entity switching) and reset state.
    const token = ++this.loadToken;
    this.clearMarkers();
    this.infoWindow?.close();
    this.hoverInfoWindow?.close();

    const eventsWithLocations = this.events().filter(e => this.hasResolvableLocation(e));
    this.zone.run(() => {
      this.geocodeError.set(null);
      this.pinCount.set(0);
      this.geocodingRemaining.set(eventsWithLocations.length);
    });

    const bounds = new maps.LatLngBounds();
    let placed = 0;

    for (const event of eventsWithLocations) {
      if (this.destroyed || !this.map || token !== this.loadToken) return;
      const coords = await this.resolveCoords(event);
      if (token !== this.loadToken) return;
      this.zone.run(() => this.geocodingRemaining.update(n => Math.max(0, n - 1)));
      if (!coords || this.destroyed || !this.map) continue;

      const marker = new maps.Marker({
        position: coords,
        map: this.map,
        title: event.name,
      });
      marker.addListener('click', () => {
        if (!this.infoWindow || !this.map) return;
        this.hoverInfoWindow?.close();
        this.infoWindow.setContent(this.popupHtml(event));
        this.infoWindow.open({ anchor: marker, map: this.map });
      });
      marker.addListener('mouseover', () => {
        if (this.hoverInfoWindow && this.map) {
          this.hoverInfoWindow.setContent(this.hoverHtml(event));
          this.hoverInfoWindow.open({ anchor: marker, map: this.map });
        }
        this.zone.run(() => this.eventHovered.emit(event.id));
      });
      marker.addListener('mouseout', () => {
        this.hoverInfoWindow?.close();
        this.zone.run(() => this.eventHovered.emit(null));
      });
      this.markers.push(marker);
      bounds.extend(coords);
      placed++;
    }

    if (this.destroyed || !this.map || token !== this.loadToken) return;
    this.zone.run(() => this.pinCount.set(placed));

    if (placed === 1) {
      this.map.setCenter(bounds.getCenter());
      this.map.setZoom(12);
    } else if (placed > 1) {
      this.map.fitBounds(bounds, 48);
    }
  }

  private clearMarkers(): void {
    for (const marker of this.markers) {
      google.maps.event.clearInstanceListeners(marker);
      marker.setMap(null);
    }
    this.markers = [];
  }

  private resolveLocationEntity(event: TimelineEvent): Entity | undefined {
    const entities = this.locationEntities();
    if (event.locationEntityId) {
      const e = entities.get(event.locationEntityId);
      if (e) return e;
    }
    if (event.location?.trim()) {
      const byName = [...entities.values()].find(
        e => e.name.toLowerCase().trim() === event.location!.trim().toLowerCase()
      );
      if (byName) return byName;
    }
    return undefined;
  }

  private hasResolvableLocation(event: TimelineEvent): boolean {
    const entity = this.resolveLocationEntity(event);
    if (entity) {
      // Only resolvable on the real-world map if it has real-world coords.
      // Fictional-only entities are handled by the fictional map component, not here.
      return entity.location?.type === 'real-world' && !!entity.location.realWorld;
    }
    return !!event.location?.trim();
  }

  private async resolveCoords(event: TimelineEvent): Promise<google.maps.LatLngLiteral | null> {
    const entity = this.resolveLocationEntity(event);
    if (entity?.location?.type === 'real-world' && entity.location.realWorld) {
      return { lat: entity.location.realWorld.lat, lng: entity.location.realWorld.lng };
    }
    // Only geocode if there's no linked entity — avoids wasting API calls on fictional places
    // whose location string won't resolve to real-world coordinates.
    if (!entity && event.location?.trim()) {
      return this.geocode(event.location.trim());
    }
    return null;
  }

  private geocode(location: string): Promise<google.maps.LatLngLiteral | null> {
    if (this.geocodeCache.has(location)) {
      return Promise.resolve(this.geocodeCache.get(location) ?? null);
    }
    return new Promise(resolve => {
      this.geocoder!.geocode({ address: location }, (results, status) => {
        let coords: google.maps.LatLngLiteral | null = null;
        if (status === 'OK' && results && results[0]) {
          const loc = results[0].geometry.location;
          coords = { lat: loc.lat(), lng: loc.lng() };
        } else if (status !== 'ZERO_RESULTS') {
          // OK / ZERO_RESULTS are normal; anything else (REQUEST_DENIED,
          // OVER_QUERY_LIMIT, etc.) is a configuration/quota problem, not a
          // fictitious place. Surface it so it isn't silently misreported.
          console.warn(`Geocoding "${location}" failed with status: ${status}`);
          this.zone.run(() => this.geocodeError.set(status));
        }
        this.geocodeCache.set(location, coords);
        resolve(coords);
      });
    });
  }

  private hoverHtml(event: TimelineEvent): string {
    const thumb = event.photo?.thumbnailUrl
      ? (() => { const f = event.photo!.thumbnailUrl.split('/').pop(); return f ? `/api/image/${f}` : null; })()
      : null;
    const img = thumb
      ? `<img src="${escapeHtml(thumb)}" alt="" style="width:60px;height:60px;object-fit:cover;border-radius:4px;flex-shrink:0" />`
      : '';
    const name = `<strong style="font-size:0.9em">${escapeHtml(event.name)}</strong>`;
    return `<div style="display:flex;align-items:center;gap:8px;max-width:200px">${img}<div>${name}</div></div>`;
  }

  private popupHtml(event: TimelineEvent): string {
    const lines = [
      `<strong>${escapeHtml(event.name)}</strong>`,
      event.timeframe ? `<em>${escapeHtml(event.timeframe)}</em>` : '',
      `<span style="font-size:0.8em;opacity:0.8">${escapeHtml(event.location ?? '')}</span>`,
      event.description
        ? `<span style="font-size:0.85em">${escapeHtml(event.description.length > 120 ? event.description.slice(0, 120) + '…' : event.description)}</span>`
        : '',
    ].filter(Boolean);
    return `<div style="display:flex;flex-direction:column;gap:2px;max-width:220px">${lines.join('')}</div>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
