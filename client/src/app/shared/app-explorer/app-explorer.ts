import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ExplorerService } from '../../services/explorer.service';
import { AiAssistantService } from '../../services/ai-assistant.service';
import { QuickChatService } from '../../services/quick-chat.service';
import { AuthService } from '../../auth/auth.service';
import { HeaderService } from '../../services/header.service';
import { SeriesContextService } from '../../services/series-context.service';

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
  private readonly aiAssistant = inject(AiAssistantService);
  private readonly quickChat = inject(QuickChatService);
  private readonly auth = inject(AuthService);
  private readonly seriesContext = inject(SeriesContextService);
  private readonly router = inject(Router);

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

  /** Primary navigation entries. */
  readonly primaryActions = computed<ExplorerAction[]>(() =>
    this.byQuery([
      { icon: 'smart_toy', label: 'Resource Manager', run: () => this.openResourceManager() },
      { icon: 'forum', label: 'Ask Quill', run: () => this.openQuickChat() },
      { icon: 'people', label: 'Entities', run: () => this.navigateTo(['/entities']) },
      { icon: 'account_tree', label: 'Relationships', run: () => this.navigateToRelationships() },
      { icon: 'photo_library', label: 'Photo Gallery', run: () => this.navigateTo(['/gallery']) },
      { icon: 'archive', label: 'Archived Items', run: () => this.navigateTo(['/archived']) },
    ]),
  );

  /** Secondary entries (stats, settings). */
  readonly secondaryActions = computed<ExplorerAction[]>(() =>
    this.byQuery([
      { icon: 'bar_chart', label: 'Writing Stats', run: () => this.navigateTo(['/writing-stats']) },
      { icon: 'settings', label: 'Settings', run: () => this.navigateTo(['/settings']) },
    ]),
  );

  /** Account entries shown at the foot of the panel. */
  readonly accountActions = computed<ExplorerAction[]>(() =>
    this.byQuery([{ icon: 'logout', label: 'Sign out', run: () => this.signOut() }]),
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

  /** Runs an action and then dismisses the explorer. */
  private closeThen(fn: () => void): void {
    fn();
    this.explorer.close();
  }

  navigateTo(commands: any[]): void {
    this.closeThen(() => this.router.navigate(commands));
  }

  openResourceManager(): void {
    this.closeThen(() => this.aiAssistant.togglePanel());
  }

  openQuickChat(): void {
    this.closeThen(() => this.quickChat.open());
  }

  navigateToRelationships(): void {
    const id = this.seriesContext.currentSeriesId();
    this.navigateTo(id ? ['/series', id, 'relationships'] : ['/relationships']);
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

  signOut(): void {
    this.explorer.reset();
    this.auth.signOut();
    this.router.navigate(['/login']);
  }
}
