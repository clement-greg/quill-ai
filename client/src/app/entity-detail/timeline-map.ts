import {
  Component,
  inject,
  input,
  signal,
  computed,
  afterNextRender,
  OnDestroy,
  ChangeDetectionStrategy,
  viewChild,
  ElementRef,
  NgZone,
} from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { TimelineEvent } from '@shared/models/timeline-event.model';
import { environment } from '../../environments/environment';
import { UserSettingsService } from '../services/user-settings.service';

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

// Loads the Google Maps JS API exactly once for the whole app. Subsequent
// callers await the same promise.
let mapsLoaderPromise: Promise<typeof google.maps> | undefined;

function loadGoogleMaps(): Promise<typeof google.maps> {
  if (mapsLoaderPromise) return mapsLoaderPromise;
  mapsLoaderPromise = new Promise((resolve, reject) => {
    if (typeof google !== 'undefined' && google.maps) {
      resolve(google.maps);
      return;
    }
    const callbackName = '__quillGoogleMapsReady';
    (window as unknown as Record<string, () => void>)[callbackName] = () => resolve(google.maps);
    const script = document.createElement('script');
    const params = new URLSearchParams({
      key: environment.googleMapsApiKey,
      callback: callbackName,
      loading: 'async',
      libraries: 'marker',
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    script.async = true;
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });
  return mapsLoaderPromise;
}

@Component({
  selector: 'app-timeline-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: block' },
  imports: [MatProgressSpinnerModule, MatIconModule],
  template: `
    <div class="map-shell">
      <div #mapEl class="map-el" role="region" aria-label="Timeline event map"></div>

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
  `],
})
export class TimelineMapComponent implements OnDestroy {
  private zone = inject(NgZone);
  private settings = inject(UserSettingsService);

  events = input<TimelineEvent[]>([]);

  geocodingRemaining = signal(0);
  pinCount = signal(0);
  ready = signal(false);
  loadError = signal(false);
  geocodeError = signal<string | null>(null);
  hasLocations = computed(() => this.events().some(e => e.location?.trim()));

  private map: google.maps.Map | undefined;
  private geocoder: google.maps.Geocoder | undefined;
  private infoWindow: google.maps.InfoWindow | undefined;
  private destroyed = false;
  private geocodeCache = new Map<string, google.maps.LatLngLiteral | null>();

  readonly mapEl = viewChild<ElementRef<HTMLDivElement>>('mapEl');

  constructor() {
    afterNextRender(() => {
      this.zone.runOutsideAngular(() => void this.setup());
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.infoWindow?.close();
    this.map = undefined;
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
    this.geocoder = new maps.Geocoder();
    this.infoWindow = new maps.InfoWindow();
    this.zone.run(() => this.ready.set(true));

    await this.loadMarkers(maps);
  }

  private async loadMarkers(maps: typeof google.maps): Promise<void> {
    const eventsWithLocations = this.events().filter(e => e.location?.trim());
    this.zone.run(() => this.geocodingRemaining.set(eventsWithLocations.length));

    const bounds = new maps.LatLngBounds();
    let placed = 0;

    for (const event of eventsWithLocations) {
      if (this.destroyed || !this.map) return;
      const coords = await this.geocode(event.location!.trim());
      this.zone.run(() => this.geocodingRemaining.update(n => Math.max(0, n - 1)));
      if (!coords || this.destroyed || !this.map) continue;

      const marker = new maps.Marker({
        position: coords,
        map: this.map,
        title: event.name,
      });
      marker.addListener('click', () => {
        if (!this.infoWindow || !this.map) return;
        this.infoWindow.setContent(this.popupHtml(event));
        this.infoWindow.open({ anchor: marker, map: this.map });
      });
      bounds.extend(coords);
      placed++;
    }

    if (this.destroyed || !this.map) return;
    this.zone.run(() => this.pinCount.set(placed));

    if (placed === 1) {
      this.map.setCenter(bounds.getCenter());
      this.map.setZoom(12);
    } else if (placed > 1) {
      this.map.fitBounds(bounds, 48);
    }
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
