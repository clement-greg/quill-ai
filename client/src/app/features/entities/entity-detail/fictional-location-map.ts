import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Entity } from '@shared/models/entity.model';
import { SeriesMap } from '@shared/models/map.model';
import { TimelineEvent } from '@shared/models/timeline-event.model';

export interface FictionalMapPin {
  entity: Entity;
  x: number;
  y: number;
  eventCount: number;
  events: TimelineEvent[];
}

@Component({
  selector: 'app-fictional-location-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    <div class="fmap-canvas">
      @if (proxyUrl(seriesMap().thumbnailUrl); as thumb) {
        <img [src]="thumb" [alt]="seriesMap().title + ' map'" class="fmap-img" />
      } @else {
        <div class="fmap-no-preview" [style.background]="seriesMap().background.color">
          <mat-icon aria-hidden="true">map</mat-icon>
          <span>No preview — open the map editor to generate one</span>
        </div>
      }
      @for (pin of pins(); track pin.entity.id) {
        <div
          class="fmap-pin"
          [style.left.%]="pin.x / seriesMap().width * 100"
          [style.top.%]="pin.y / seriesMap().height * 100"
          (mouseenter)="hoveredPinId.set(pin.entity.id); placeEntityHovered.emit(pin.entity.id)"
          (mouseleave)="hoveredPinId.set(null); placeEntityHovered.emit(null)">
          <button
            type="button"
            class="fmap-pin-btn"
            [attr.aria-label]="pin.entity.name + ' — ' + pin.eventCount + (pin.eventCount === 1 ? ' event' : ' events')"
            (focus)="hoveredPinId.set(pin.entity.id); placeEntityHovered.emit(pin.entity.id)"
            (blur)="hoveredPinId.set(null); placeEntityHovered.emit(null)"
            (click)="placeEntityClicked.emit(pin.entity.id)">
            <mat-icon class="fmap-pin-icon" aria-hidden="true">location_on</mat-icon>
            <span class="fmap-pin-label">{{ pin.entity.name }}</span>
          </button>

          @if (hoveredPinId() === pin.entity.id) {
            <div class="fmap-pin-tooltip" role="tooltip">
              @for (event of pin.events; track event.id) {
                <div class="fmap-tooltip-event">
                  @if (event.photo?.thumbnailUrl; as thumb) {
                    <img [src]="proxyUrl(thumb)" [alt]="event.name" class="fmap-tooltip-img" />
                  }
                  <span class="fmap-tooltip-name">{{ event.name }}</span>
                </div>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .fmap-canvas {
      position: relative;
      width: 100%;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid var(--mat-sys-outline-variant, #cac4d0);
    }

    .fmap-img {
      display: block;
      width: 100%;
      height: auto;
      max-width: 100%;
      pointer-events: none;
    }

    .fmap-no-preview {
      width: 100%;
      height: 200px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: rgba(255,255,255,0.7);
      mat-icon { font-size: 40px; width: 40px; height: 40px; opacity: 0.5; }
      span { font-size: 13px; opacity: 0.7; }
    }

    /* Outer wrapper: zero-size anchor at the map coordinate */
    .fmap-pin {
      position: absolute;
      width: 0;
      height: 0;
      overflow: visible;
    }

    .fmap-pin-btn {
      position: absolute;
      width: 0;
      height: 0;
      background: none;
      border: none;
      padding: 0;
      cursor: pointer;
      overflow: visible;
    }

    /* The visible icon, centered above the anchor point */
    .fmap-pin-icon {
      position: absolute;
      font-size: 28px;
      width: 28px;
      height: 28px;
      left: -14px;
      bottom: 0;
      color: var(--mat-sys-primary, #6750a4);
      filter: drop-shadow(0 2px 3px rgba(0,0,0,0.5));
      transition: transform 0.1s ease, filter 0.1s ease;
      transform-origin: bottom center;

      .fmap-pin:hover &,
      .fmap-pin-btn:focus-visible & {
        transform: scale(1.25);
        filter: drop-shadow(0 3px 5px rgba(0,0,0,0.7));
      }
    }

    .fmap-pin-btn:focus-visible { outline: none; }

    .fmap-pin-label {
      position: absolute;
      bottom: -20px;
      left: 50%;
      transform: translateX(-50%);
      white-space: nowrap;
      font-size: 11px;
      font-weight: 600;
      color: #fff;
      background: rgba(0,0,0,0.6);
      padding: 1px 5px;
      border-radius: 4px;
      pointer-events: none;
    }

    .fmap-pin-tooltip {
      position: absolute;
      bottom: 36px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(20, 20, 20, 0.92);
      backdrop-filter: blur(6px);
      border-radius: 8px;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 140px;
      max-width: 200px;
      pointer-events: none;
      z-index: 10;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }

    .fmap-tooltip-event {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .fmap-tooltip-img {
      width: 40px;
      height: 40px;
      object-fit: cover;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .fmap-tooltip-name {
      font-size: 12px;
      font-weight: 500;
      color: #fff;
      line-height: 1.3;
      word-break: break-word;
    }
  `],
})
export class FictionalLocationMapComponent {
  seriesMap = input.required<SeriesMap>();
  pins = input<FictionalMapPin[]>([]);
  placeEntityHovered = output<string | null>();
  placeEntityClicked = output<string>();

  hoveredPinId = signal<string | null>(null);

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }
}
