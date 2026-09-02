import { Directive, ElementRef, OnDestroy, effect, inject, input, signal } from '@angular/core';

/**
 * Windowed rendering for grids of media. The host element keeps its box (so the
 * grid's layout and scrollbar never move), but the caller only renders the
 * expensive contents — `<img>`, `<video>` — while the host is near the viewport.
 *
 * ```html
 * <div class="tile" appLazyRender #tile="lazyRender">
 *   @if (tile.visible()) { <img [src]="url" /> }
 * </div>
 * ```
 *
 * One IntersectionObserver is shared per root margin, so a gallery of hundreds
 * of tiles costs one observer rather than hundreds.
 */

const OBSERVERS = new Map<string, IntersectionObserver>();
const CALLBACKS = new WeakMap<Element, (visible: boolean) => void>();

function observerFor(rootMargin: string): IntersectionObserver {
  let observer = OBSERVERS.get(rootMargin);
  if (!observer) {
    observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) CALLBACKS.get(entry.target)?.(entry.isIntersecting);
      },
      { rootMargin }
    );
    OBSERVERS.set(rootMargin, observer);
  }
  return observer;
}

@Directive({
  selector: '[appLazyRender]',
  exportAs: 'lazyRender',
})
export class LazyRenderDirective implements OnDestroy {
  /**
   * How far outside the viewport a tile starts (and stops) rendering. Generous
   * by default so scrolling never shows an empty tile, and so a tile that sits
   * just off screen is not torn down and rebuilt on every small scroll.
   */
  readonly rootMargin = input('800px', { alias: 'appLazyRender' });

  readonly visible = signal(false);

  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private observer: IntersectionObserver | null = null;

  constructor() {
    CALLBACKS.set(this.element, v => this.visible.set(v));
    effect(() => {
      const margin = this.rootMargin() || '800px';
      this.observer?.unobserve(this.element);
      this.observer = observerFor(margin);
      this.observer.observe(this.element);
    });
  }

  ngOnDestroy(): void {
    this.observer?.unobserve(this.element);
    CALLBACKS.delete(this.element);
  }
}
