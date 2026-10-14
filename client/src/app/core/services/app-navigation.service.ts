import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '@app/core/auth/auth.service';
import { ExplorerService } from '@app/core/services/explorer.service';
import { SeriesContextService } from '@app/core/services/series-context.service';
import { AiAssistantService } from '@app/features/ai/ai-assistant.service';

/** An app-wide destination, shared by the explorer drawer and the desktop menu bar. */
export interface AppNavItem {
  /** Stable key, used by the desktop menu to route a click back here. */
  id: string;
  icon: string;
  label: string;
  run: () => void;
}

/**
 * The app's top-level destinations. The explorer drawer and the desktop app's
 * native menus both render from these lists so the two never drift apart.
 */
@Injectable({ providedIn: 'root' })
export class AppNavigationService {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly explorer = inject(ExplorerService);
  private readonly seriesContext = inject(SeriesContextService);
  private readonly aiAssistant = inject(AiAssistantService);

  /** Primary navigation entries. */
  readonly primary: readonly AppNavItem[] = [
    { id: 'resource-manager', icon: 'smart_toy', label: 'Resource Manager', run: () => this.aiAssistant.togglePanel() },
    { id: 'thoughts', icon: 'lightbulb', label: 'Thoughts', run: () => this.go(['/thoughts']) },
    { id: 'entities', icon: 'people', label: 'Entities', run: () => this.go(['/entities']) },
    { id: 'relationships', icon: 'account_tree', label: 'Relationships', run: () => this.openRelationships() },
    { id: 'maps', icon: 'map', label: 'Maps', run: () => this.go(['/maps']) },
    { id: 'gallery', icon: 'photo_library', label: 'Photo Gallery', run: () => this.go(['/gallery']) },
    { id: 'archived', icon: 'archive', label: 'Archived Items', run: () => this.go(['/archived']) },
    { id: 'generation-queue', icon: 'queue', label: 'Generation Queue', run: () => this.go(['/generation-queue']) },
  ];

  /** Secondary entries (stats, settings). */
  readonly secondary: readonly AppNavItem[] = [
    { id: 'writing-stats', icon: 'bar_chart', label: 'Writing Stats', run: () => this.go(['/writing-stats']) },
    { id: 'settings', icon: 'settings', label: 'Settings', run: () => this.go(['/settings']) },
  ];

  /** Looks up a primary or secondary entry by id. */
  find(id: string): AppNavItem | undefined {
    return [...this.primary, ...this.secondary].find(item => item.id === id);
  }

  openHome(): void {
    this.go(['/series']);
  }

  openSeries(id: string): void {
    this.go(['/series', id]);
  }

  openBook(id: string): void {
    this.go(['/books', id]);
  }

  openChapter(id: string): void {
    this.go(['/chapters', id, 'edit']);
  }

  signOut(): void {
    this.explorer.reset();
    this.auth.signOut();
    this.go(['/login']);
  }

  private openRelationships(): void {
    const id = this.seriesContext.currentSeriesId();
    this.go(id ? ['/series', id, 'relationships'] : ['/relationships']);
  }

  private go(commands: unknown[]): void {
    this.router.navigate(commands);
  }
}
