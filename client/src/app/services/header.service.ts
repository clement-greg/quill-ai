import { Injectable, signal, computed } from '@angular/core';

export interface BreadcrumbDropdownItem {
  label: string;
  link: string;
  isCurrent?: boolean;
}

export interface BreadcrumbItem {
  label: string;
  link?: string;
  dropdownItems?: BreadcrumbDropdownItem[];
}

export interface HeaderMenuAction {
  icon: string;
  label: string;
  action: () => void;
}

@Injectable({ providedIn: 'root' })
export class HeaderService {
  private _contextCrumbs = signal<BreadcrumbItem[]>([]);
  private _pageCrumbs = signal<BreadcrumbItem[]>([]);

  /** All visible breadcrumbs: persistent context (series/book/chapter) followed by the current page label. */
  breadcrumbs = computed(() => [...this._contextCrumbs(), ...this._pageCrumbs()]);
  menuActions = signal<HeaderMenuAction[]>([]);

  /**
   * Set hierarchical context breadcrumbs (series / book / chapter).
   * These persist when navigating to flat pages like Settings.
   */
  setContext(crumbs: BreadcrumbItem[], actions: HeaderMenuAction[] = []): void {
    this._contextCrumbs.set(crumbs);
    this._pageCrumbs.set([]);
    this.menuActions.set(actions);
  }

  /**
   * Set a flat page label that is shown after the persisted context crumbs.
   * Does not overwrite the context.
   */
  setPage(label: string, actions: HeaderMenuAction[] = []): void {
    this._pageCrumbs.set([{ label }]);
    this.menuActions.set(actions);
  }

  /** Alias for setContext — kept for existing callers on series/book/chapter pages. */
  set(crumbs: BreadcrumbItem[], actions: HeaderMenuAction[] = []): void {
    this.setContext(crumbs, actions);
  }

  /** Clears only the page label; context crumbs are preserved. */
  clear(): void {
    this._pageCrumbs.set([]);
    this.menuActions.set([]);
  }

  /** Clears everything including the persisted context (e.g. on logout). */
  clearAll(): void {
    this._contextCrumbs.set([]);
    this._pageCrumbs.set([]);
    this.menuActions.set([]);
  }
}
