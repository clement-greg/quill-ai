import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ExplorerService } from '../../services/explorer.service';
import { AiAssistantService } from '../../services/ai-assistant.service';
import { AuthService } from '../../auth/auth.service';
import { HeaderService } from '../../services/header.service';
import { SeriesContextService } from '../../services/series-context.service';

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
  private readonly auth = inject(AuthService);
  private readonly seriesContext = inject(SeriesContextService);
  private readonly router = inject(Router);

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
