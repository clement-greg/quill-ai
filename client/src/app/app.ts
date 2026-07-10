import { Component, inject, computed, OnInit, OnDestroy, effect, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterOutlet, RouterLink, Router, NavigationEnd } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { AuthService } from '@app/core/auth/auth.service';
import { HeaderService } from '@app/core/services/header.service';
import { UpdateCheckService } from '@app/core/services/update-check.service';
import { AiAssistantComponent } from '@app/features/ai/ai-assistant/ai-assistant';
import { AiAssistantService } from '@app/features/ai/ai-assistant.service';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { ExplorerService } from '@app/core/services/explorer.service';
import { BreadcrumbDropdownComponent } from '@app/shared/breadcrumb-dropdown/breadcrumb-dropdown';
import { AppExplorerComponent } from '@app/shared/app-explorer/app-explorer';
import { QuickChatComponent } from '@app/features/ai/quick-chat/quick-chat';
import { QuickChatService } from '@app/features/ai/quick-chat.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, MatToolbarModule, MatButtonModule, MatIconModule, AiAssistantComponent, BreadcrumbDropdownComponent, AppExplorerComponent, QuickChatComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: {
    '(document:keydown)': 'onGlobalKeyDown($event)',
  },
})
export class App implements OnInit, OnDestroy {
  auth = inject(AuthService);
  header = inject(HeaderService);
  updateCheck = inject(UpdateCheckService);
  aiAssistant = inject(AiAssistantService);
  explorer = inject(ExplorerService);
  private router = inject(Router);
  private quickChat = inject(QuickChatService);
  settings = inject(UserSettingsService);
  readonly isResizing = signal(false);

  /** Global shortcut: Ctrl/Cmd+I toggles the quick-launch "Ask Quill" chat. */
  onGlobalKeyDown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'i') {
      if (!this.auth.currentUser()) return;
      event.preventDefault();
      this.quickChat.toggle();
    }
  }

  private panelWidthEffect = effect(() => {
    document.documentElement.style.setProperty(
      '--ai-panel-width',
      this.aiAssistant.panelWidth() + 'px'
    );
  });

  private panelNarrowClassEffect = effect(() => {
    const shouldCompact = this.aiAssistant.isOpen()
      && window.matchMedia('(min-width: 1800px)').matches
      && this.aiAssistant.panelWidth() <= 700;
    document.body.classList.toggle('ai-panel-narrow-actions', shouldCompact);
  });

  onResizerPointerDown(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.aiAssistant.panelWidth();
    this.isResizing.set(true);

    const onMove = (e: PointerEvent) => {
      const delta = startX - e.clientX;
      const newWidth = Math.min(Math.max(startWidth + delta, 280), window.innerWidth - 300);
      this.aiAssistant.panelWidth.set(newWidth);
    };

    const onUp = () => {
      this.isResizing.set(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  private currentUrl = toSignal(
    this.router.events.pipe(
      filter(e => e instanceof NavigationEnd),
      map(e => (e as NavigationEnd).urlAfterRedirects),
      startWith(this.router.url)
    )
  );

  isUnthemed = computed(() => {
    const url = this.currentUrl() ?? '';
    return url === '/home' || url.startsWith('/login');
  });

  private darkModeEffect = effect(() => {
    const theme = this.settings.colorTheme();
    const unthemed = this.isUnthemed();
    // Remove any previously applied theme class
    document.body.classList.forEach(cls => {
      if (cls.startsWith('theme-') || cls === 'dark-theme') {
        document.body.classList.remove(cls);
      }
    });
    if (!unthemed && theme && theme !== 'default') {
      document.body.classList.add(`theme-${theme}`);
    }
  });

  private editorFontEffect = effect(() => {
    const sizeMap: Record<string, string> = {
      xs:     '0.75rem',
      small:  '0.875rem',
      normal: '1rem',
      large:  '1.125rem',
      xl:     '1.3rem',
    };
    const familyMap: Record<string, string> = {
      'serif':      "Georgia, 'Times New Roman', serif",
      'sans-serif': "system-ui, 'Roboto', Arial, sans-serif",
    };
    document.body.style.setProperty(
      '--editor-font-size',
      sizeMap[this.settings.editorFontSize()] ?? '1rem'
    );
    document.body.style.setProperty(
      '--editor-font-family',
      familyMap[this.settings.editorFontFamily()] ?? "Georgia, 'Times New Roman', serif"
    );
  });

  private userLoadEffect = effect(() => {
    if (this.auth.currentUser()) {
      this.settings.loadFromServer();
    }
  });

  hasBackNav = computed(() => {
    const url = this.currentUrl() ?? '';
    return url !== '/series' && url !== '/' && url !== '/login';
  });

  goBack() {
    history.back();
  }

  logoSrc = computed(() =>
    this.settings.colorTheme() === 'minimalist'
      ? '/quill-ai-logo.svg'
      : '/quill-ai-logo-white.svg'
  );

  ngOnInit(): void {
    this.updateCheck.start();
  }

  ngOnDestroy(): void {
    this.updateCheck.stop();
    document.body.classList.remove('ai-panel-narrow-actions');
  }

  reload(): void {
    window.location.reload();
  }
}
