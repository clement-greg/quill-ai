import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

/**
 * Full-screen, read-only map viewer. Shows a map's snapshot on a black
 * backdrop with floating Edit and Close actions. Purely presentational: it
 * emits `edit`/`closed` and leaves navigation and open/close state to the host
 * (escape handling lives with the host so stacked overlays close in order).
 */
@Component({
  selector: 'app-map-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
    <div class="lightbox" role="dialog" [attr.aria-label]="title() + ' preview'" (click)="closed.emit()">
      <!-- Floating action buttons — stop clicks reaching the backdrop -->
      <div class="lightbox-actions" (click)="$event.stopPropagation()">
        <span class="lightbox-map-title">{{ title() }}</span>
        <button mat-mini-fab (click)="edit.emit()" aria-label="Edit map" matTooltip="Edit map">
          <mat-icon>edit</mat-icon>
        </button>
        <button mat-mini-fab (click)="closed.emit()" aria-label="Close preview" matTooltip="Close">
          <mat-icon>close</mat-icon>
        </button>
      </div>

      @if (thumbnailUrl()) {
        <img class="lightbox-img" [src]="proxyUrl(thumbnailUrl()!)"
             [alt]="title()" (click)="$event.stopPropagation()" />
      } @else {
        <div class="lightbox-placeholder" [style.background]="placeholderColor()"
             (click)="$event.stopPropagation()">
          <mat-icon aria-hidden="true">map</mat-icon>
          <p>No preview yet — open the editor to generate one.</p>
        </div>
      }
    </div>
  `,
  styles: `
    .lightbox {
      position: fixed;
      inset: 0;
      z-index: 1300;
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
export class MapPreviewComponent {
  readonly title = input.required<string>();
  readonly thumbnailUrl = input<string | undefined>(undefined);
  /** Background shown behind the placeholder when there's no snapshot. */
  readonly placeholderColor = input<string | undefined>(undefined);

  readonly edit = output<void>();
  readonly closed = output<void>();

  /** Rewrites a stored upload URL to the same-origin image proxy. */
  proxyUrl(url: string): string {
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : url;
  }
}
