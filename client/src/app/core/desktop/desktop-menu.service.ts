import { DestroyRef, Injectable, Injector, computed, effect, inject, untracked } from '@angular/core';
import { AuthService } from '@app/core/auth/auth.service';
import { AppNavigationService } from '@app/core/services/app-navigation.service';
import { ExplorerService } from '@app/core/services/explorer.service';
import { HeaderService } from '@app/core/services/header.service';
import { UnsavedDraftsService } from '@app/features/chapters/chapter-edit/unsaved-drafts.service';
import { DesktopMenuCommand, DesktopMenuModel, getQuillDesktop } from './quill-desktop';

/**
 * Mirrors the explorer drawer into the desktop app's native menu bar: the same
 * destinations (Go), the current page's actions (Page) and the
 * Series → Book → Chapter tree (Library), plus the toolbar's unsaved drafts
 * (File). The menus themselves are built by the
 * Electron main process (desktop/app-menu.js); this service supplies their
 * content and carries out the clicks. Does nothing in a normal browser.
 */
@Injectable({ providedIn: 'root' })
export class DesktopMenuService {
  private readonly auth = inject(AuthService);
  private readonly explorer = inject(ExplorerService);
  private readonly header = inject(HeaderService);
  private readonly navigation = inject(AppNavigationService);
  private readonly unsavedDrafts = inject(UnsavedDraftsService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  private started = false;

  /** The menu content for the current app state. */
  readonly model = computed<DesktopMenuModel>(() => {
    const signedIn = this.auth.currentUser() !== null;
    return {
      signedIn,
      navigation: [...this.navigation.primary, ...this.navigation.secondary]
        .filter(item => item.id !== 'settings') // the app menu has its own Settings entry
        .map(({ id, label }) => ({ id, label })),
      pageActions: signedIn ? this.header.menuActions().map((a, i) => ({ id: String(i), label: a.label })) : [],
      drafts: signedIn ? this.unsavedDrafts.chapters().map(c => ({ id: c.id, label: c.title })) : [],
      library: {
        loaded: signedIn && this.explorer.libraryLoaded(),
        series: signedIn
          ? this.explorer.series().map(s => ({
              id: s.id,
              title: s.title,
              books: this.explorer.booksFor(s.id).map(b => ({
                id: b.id,
                title: b.title,
                chapters: this.explorer.chaptersFor(b.id).map(c => ({ id: c.id, title: c.title })),
              })),
            }))
          : [],
      },
    };
  });

  /** Starts syncing the menu bar. Call once from the app shell. */
  start(): void {
    const desktop = getQuillDesktop();
    if (this.started || !desktop?.setMenuModel || !desktop.onMenuCommand) return;
    this.started = true;
    const { setMenuModel, onMenuCommand } = desktop;

    // The Library menu needs the tree even if the explorer is never opened.
    effect(() => {
      if (this.auth.currentUser()) untracked(() => this.explorer.loadLibrary());
    }, { injector: this.injector });
    effect(() => setMenuModel(this.model()), { injector: this.injector });

    const unsubscribe = onMenuCommand(command => this.run(command));
    this.destroyRef.onDestroy(unsubscribe);
  }

  /** Carries out a native menu click. */
  run(command: DesktopMenuCommand): void {
    const signedIn = this.auth.currentUser() !== null;
    switch (command.type) {
      case 'navigate':
        if (signedIn) this.navigation.find(command.id)?.run();
        break;
      case 'page-action': {
        const action = signedIn ? this.header.menuActions()[Number(command.id)] : undefined;
        action?.action();
        break;
      }
      case 'open':
        if (!signedIn) break;
        if (command.kind === 'series') this.navigation.openSeries(command.id);
        else if (command.kind === 'book') this.navigation.openBook(command.id);
        else this.navigation.openChapter(command.id);
        break;
      case 'home':
        if (signedIn) this.navigation.openHome();
        break;
      case 'toggle-explorer':
        if (signedIn) this.explorer.toggle();
        break;
      case 'refresh-library':
        if (signedIn) this.explorer.refreshLibrary();
        break;
      case 'sign-out':
        if (signedIn) this.navigation.signOut();
        break;
    }
  }
}
