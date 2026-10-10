import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/**
 * Whether source thumbnails are hidden behind a placeholder. Module state, so it
 * holds across dialogs for the rest of the session and resets on reload.
 */
const hidden = signal(false);

/**
 * The source photo shown at the top of the generation dialogs. Double-clicking
 * it swaps in a placeholder, which then sticks for every dialog until reload.
 */
@Component({
  selector: 'app-source-thumbnail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    @if (hidden()) {
      <div class="placeholder" role="img" [attr.aria-label]="alt()">
        <mat-icon>image</mat-icon>
      </div>
    } @else {
      <img [src]="src()" [alt]="alt()" (dblclick)="hide()" />
    }
  `,
  styles: [`
    :host { display: block; flex: 0 0 auto; }
    img, .placeholder { width: 88px; height: 88px; border-radius: 8px; display: block; }
    img { object-fit: cover; }
    .placeholder {
      display: flex; align-items: center; justify-content: center;
      background: var(--mat-sys-surface-container-high, #e7e0ec);
      color: var(--mat-sys-on-surface-variant, #49454f);
    }
    .placeholder mat-icon { width: 36px; height: 36px; font-size: 36px; }
  `],
})
export class SourceThumbnailComponent {
  readonly src = input.required<string>();
  readonly alt = input('');

  readonly hidden = hidden.asReadonly();

  hide(): void {
    hidden.set(true);
  }
}

/** Shows real thumbnails again. Only for tests — the app has no way to undo. */
export function resetSourceThumbnailPlaceholder(): void {
  hidden.set(false);
}
