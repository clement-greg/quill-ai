import { Component, inject, computed, OnInit, OnDestroy, effect } from '@angular/core';
import { RouterOutlet, RouterLink, Router } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { AuthService } from './auth/auth.service';
import { HeaderService } from './services/header.service';
import { EntityPanelComponent } from './shared/entity-panel/entity-panel';
import { UpdateCheckService } from './services/update-check.service';
import { AiAssistantComponent } from './ai-assistant/ai-assistant';
import { AiAssistantService } from './services/ai-assistant.service';
import { UserSettingsService } from './services/user-settings.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, MatToolbarModule, MatButtonModule, MatIconModule, MatMenuModule, MatDividerModule, EntityPanelComponent, AiAssistantComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  auth = inject(AuthService);
  header = inject(HeaderService);
  updateCheck = inject(UpdateCheckService);
  aiAssistant = inject(AiAssistantService);
  private router = inject(Router);
  settings = inject(UserSettingsService);

  private darkModeEffect = effect(() => {
    document.body.classList.toggle('dark-theme', this.settings.darkMode());
  });

  private userLoadEffect = effect(() => {
    if (this.auth.currentUser()) {
      this.settings.loadFromServer();
    }
  });

  backLink = computed(() => {
    const crumbs = this.header.breadcrumbs().filter(c => c.link);
    return crumbs.length > 0 ? crumbs[crumbs.length - 1].link! : null;
  });

  ngOnInit(): void {
    this.updateCheck.start();
  }

  ngOnDestroy(): void {
    this.updateCheck.stop();
  }

  reload(): void {
    window.location.reload();
  }

  signOut(): void {
    this.auth.signOut();
    this.router.navigate(['/login']);
  }
}
