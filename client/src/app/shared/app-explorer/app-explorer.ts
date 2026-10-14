import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ExplorerService } from '@app/core/services/explorer.service';
import { HeaderService } from '@app/core/services/header.service';
import { AppNavItem, AppNavigationService } from '@app/core/services/app-navigation.service';

export type ViewMode = 'list' | 'tiles' | 'large';

/** A single clickable row in the explorer's action menus. */
interface ExplorerAction {
  icon: string;
  label: string;
  run: () => void;
}

@Component({
  selector: 'app-app-explorer',
  imports: [MatButtonModule, MatIconModule, MatDividerModule, MatProgressSpinnerModule],
  templateUrl: './app-explorer.html',
  styleUrl: './app-explorer.scss',
})
export class AppExplorerComponent {
  readonly explorer = inject(ExplorerService);
  readonly header = inject(HeaderService);
  private readonly navigation = inject(AppNavigationService);
  private readonly router = inject(Router);

  readonly viewMode = signal<ViewMode>(
    (localStorage.getItem('quill-explorer-view') as ViewMode | null) ?? 'list',
  );

  setViewMode(mode: ViewMode): void {
    this.viewMode.set(mode);
    localStorage.setItem('quill-explorer-view', mode);
  }

  private readonly query = computed(() => this.explorer.filter().trim().toLowerCase());

  /** Page-contextual actions supplied by the header (e.g. per-entity actions). */
  readonly contextActions = computed<ExplorerAction[]>(() =>
    this.byQuery(
      this.header.menuActions().map(a => ({
        icon: a.icon,
        label: a.label,
        run: () => this.runAction(a.action),
      })),
    ),
  );

  /** Primary navigation entries (shared with the desktop app's menu bar). */
  readonly primaryActions = computed<ExplorerAction[]>(() => this.byQuery(this.navigation.primary.map(this.toAction)));

  /** Secondary entries (stats, settings). */
  readonly secondaryActions = computed<ExplorerAction[]>(() => this.byQuery(this.navigation.secondary.map(this.toAction)));

  /** Account entries shown at the foot of the panel. */
  readonly accountActions = computed<ExplorerAction[]>(() =>
    this.byQuery([{ icon: 'logout', label: 'Sign out', run: () => this.navigation.signOut() }]),
  );

  /** True when any action menu has a visible entry (used to gate dividers). */
  readonly hasMenuActions = computed(
    () =>
      this.contextActions().length > 0 ||
      this.primaryActions().length > 0 ||
      this.secondaryActions().length > 0,
  );

  /** Narrows an action list by the active filter (matched against the label). */
  private byQuery(actions: ExplorerAction[]): ExplorerAction[] {
    const q = this.query();
    if (!q) return actions;
    return actions.filter(a => a.label.toLowerCase().includes(q));
  }

  /** Wraps a shared destination so choosing it also dismisses the explorer. */
  private readonly toAction = (item: AppNavItem): ExplorerAction => ({
    icon: item.icon,
    label: item.label,
    run: () => this.closeThen(item.run),
  });

  /** Runs an action and then dismisses the explorer. */
  private closeThen(fn: () => void): void {
    fn();
    this.explorer.close();
  }

  navigateTo(commands: any[]): void {
    this.closeThen(() => this.router.navigate(commands));
  }

  runAction(action: () => void): void {
    this.closeThen(action);
  }

  /** Rewrites a stored Azure blob URL to the in-app image proxy endpoint. */
  proxyUrl(azureUrl: string | undefined): string | null {
    if (!azureUrl) return null;
    const filename = azureUrl.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }
}
