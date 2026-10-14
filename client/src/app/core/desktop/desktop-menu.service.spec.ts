import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { AuthService, GoogleUser } from '@app/core/auth/auth.service';
import { AppNavItem, AppNavigationService } from '@app/core/services/app-navigation.service';
import { ExplorerService } from '@app/core/services/explorer.service';
import { HeaderMenuAction, HeaderService } from '@app/core/services/header.service';
import { UnsavedDraftsService } from '@app/features/chapters/chapter-edit/unsaved-drafts.service';
import { Chapter } from '@shared/models/chapter.model';
import { DesktopMenuService } from './desktop-menu.service';
import { DesktopMenuCommand, DesktopMenuModel } from './quill-desktop';

const user: GoogleUser = { email: 'a@b.c', name: 'A', picture: '', idToken: 't' };

describe('DesktopMenuService', () => {
  let currentUser: ReturnType<typeof signal<GoogleUser | null>>;
  let menuActions: ReturnType<typeof signal<HeaderMenuAction[]>>;
  let draftChapters: ReturnType<typeof signal<Chapter[]>>;
  let explorer: {
    series: ReturnType<typeof signal<{ id: string; title: string }[]>>;
    libraryLoaded: ReturnType<typeof signal<boolean>>;
    booksFor: ReturnType<typeof vi.fn>;
    chaptersFor: ReturnType<typeof vi.fn>;
    loadLibrary: ReturnType<typeof vi.fn>;
    refreshLibrary: ReturnType<typeof vi.fn>;
    toggle: ReturnType<typeof vi.fn>;
  };
  let navigation: {
    primary: AppNavItem[];
    secondary: AppNavItem[];
    find: (id: string) => AppNavItem | undefined;
    openHome: ReturnType<typeof vi.fn>;
    openSeries: ReturnType<typeof vi.fn>;
    openBook: ReturnType<typeof vi.fn>;
    openChapter: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  };

  const win = window as Window & { quillDesktop?: unknown };

  beforeEach(() => {
    currentUser = signal<GoogleUser | null>(user);
    menuActions = signal<HeaderMenuAction[]>([]);
    draftChapters = signal<Chapter[]>([{ id: 'c1', title: 'The Spice' } as Chapter]);
    explorer = {
      series: signal([{ id: 's1', title: 'Dune Saga' }]),
      libraryLoaded: signal(true),
      booksFor: vi.fn((id: string) => (id === 's1' ? [{ id: 'b1', title: 'Dune' }] : [])),
      chaptersFor: vi.fn((id: string) => (id === 'b1' ? [{ id: 'c1', title: 'The Spice' }] : [])),
      loadLibrary: vi.fn(),
      refreshLibrary: vi.fn(),
      toggle: vi.fn(),
    };
    const thoughts: AppNavItem = { id: 'thoughts', icon: 'lightbulb', label: 'Thoughts', run: vi.fn() };
    const stats: AppNavItem = { id: 'writing-stats', icon: 'bar_chart', label: 'Writing Stats', run: vi.fn() };
    const settings: AppNavItem = { id: 'settings', icon: 'settings', label: 'Settings', run: vi.fn() };
    navigation = {
      primary: [thoughts],
      secondary: [stats, settings],
      find: (id: string) => [thoughts, stats, settings].find(i => i.id === id),
      openHome: vi.fn(),
      openSeries: vi.fn(),
      openBook: vi.fn(),
      openChapter: vi.fn(),
      signOut: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { currentUser } },
        { provide: HeaderService, useValue: { menuActions } },
        { provide: ExplorerService, useValue: explorer },
        { provide: AppNavigationService, useValue: navigation },
        { provide: UnsavedDraftsService, useValue: { chapters: draftChapters } },
      ],
    });
  });

  afterEach(() => {
    delete win.quillDesktop;
  });

  function installBridge() {
    const models: DesktopMenuModel[] = [];
    let listener: ((c: DesktopMenuCommand) => void) | null = null;
    const unsubscribe = vi.fn();
    win.quillDesktop = {
      signInWithGoogle: vi.fn(),
      setMenuModel: (m: DesktopMenuModel) => models.push(m),
      onMenuCommand: (l: (c: DesktopMenuCommand) => void) => {
        listener = l;
        return unsubscribe;
      },
    };
    return { models, click: (c: DesktopMenuCommand) => listener!(c), unsubscribe };
  }

  describe('model', () => {
    it('mirrors the explorer: destinations, page actions, unsaved drafts and the library tree', () => {
      menuActions.set([{ icon: 'edit', label: 'Rename', action: vi.fn() }]);
      const service = TestBed.inject(DesktopMenuService);

      expect(service.model()).toEqual({
        signedIn: true,
        navigation: [
          { id: 'thoughts', label: 'Thoughts' },
          { id: 'writing-stats', label: 'Writing Stats' },
        ],
        pageActions: [{ id: '0', label: 'Rename' }],
        drafts: [{ id: 'c1', label: 'The Spice' }],
        library: {
          loaded: true,
          series: [{ id: 's1', title: 'Dune Saga', books: [{ id: 'b1', title: 'Dune', chapters: [{ id: 'c1', title: 'The Spice' }] }] }],
        },
      });
    });

    it('leaves Settings out of Go (the app menu has it)', () => {
      const ids = TestBed.inject(DesktopMenuService).model().navigation.map(i => i.id);
      expect(ids).not.toContain('settings');
    });

    it('hides page actions, drafts and the library when signed out', () => {
      menuActions.set([{ icon: 'edit', label: 'Rename', action: vi.fn() }]);
      currentUser.set(null);
      const model = TestBed.inject(DesktopMenuService).model();

      expect(model.signedIn).toBe(false);
      expect(model.pageActions).toEqual([]);
      expect(model.drafts).toEqual([]);
      expect(model.library).toEqual({ loaded: false, series: [] });
    });
  });

  describe('start', () => {
    it('does nothing in a browser', () => {
      expect(() => TestBed.inject(DesktopMenuService).start()).not.toThrow();
      expect(explorer.loadLibrary).not.toHaveBeenCalled();
    });

    it('does nothing with an older desktop build that has no menu bridge', () => {
      win.quillDesktop = { signInWithGoogle: vi.fn() };
      TestBed.inject(DesktopMenuService).start();
      TestBed.tick();
      expect(explorer.loadLibrary).not.toHaveBeenCalled();
    });

    it('loads the library and pushes the model, then pushes again on change', () => {
      const { models } = installBridge();
      TestBed.inject(DesktopMenuService).start();
      TestBed.tick();

      expect(explorer.loadLibrary).toHaveBeenCalled();
      expect(models.at(-1)?.library.series[0].title).toBe('Dune Saga');

      explorer.series.set([{ id: 's2', title: 'The Culture' }]);
      TestBed.tick();
      expect(models.at(-1)?.library.series[0].title).toBe('The Culture');
    });

    it('does not load the library while signed out', () => {
      currentUser.set(null);
      const { models } = installBridge();
      TestBed.inject(DesktopMenuService).start();
      TestBed.tick();

      expect(explorer.loadLibrary).not.toHaveBeenCalled();
      expect(models.at(-1)?.signedIn).toBe(false);
    });

    it('starts only once', () => {
      installBridge();
      const service = TestBed.inject(DesktopMenuService);
      service.start();
      service.start();
      TestBed.tick();
      expect(explorer.loadLibrary).toHaveBeenCalledTimes(1);
    });
  });

  describe('menu clicks', () => {
    it('routes each command to the matching app action', () => {
      const rename = vi.fn();
      menuActions.set([{ icon: 'edit', label: 'Rename', action: rename }]);
      const { click } = installBridge();
      TestBed.inject(DesktopMenuService).start();

      click({ type: 'navigate', id: 'thoughts' });
      click({ type: 'page-action', id: '0' });
      click({ type: 'open', kind: 'series', id: 's1' });
      click({ type: 'open', kind: 'book', id: 'b1' });
      click({ type: 'open', kind: 'chapter', id: 'c1' });
      click({ type: 'home' });
      click({ type: 'toggle-explorer' });
      click({ type: 'refresh-library' });
      click({ type: 'sign-out' });

      expect(navigation.find('thoughts')!.run).toHaveBeenCalled();
      expect(rename).toHaveBeenCalled();
      expect(navigation.openSeries).toHaveBeenCalledWith('s1');
      expect(navigation.openBook).toHaveBeenCalledWith('b1');
      expect(navigation.openChapter).toHaveBeenCalledWith('c1');
      expect(navigation.openHome).toHaveBeenCalled();
      expect(explorer.toggle).toHaveBeenCalled();
      expect(explorer.refreshLibrary).toHaveBeenCalled();
      expect(navigation.signOut).toHaveBeenCalled();
    });

    it('ignores unknown destinations and stale page-action ids', () => {
      const service = TestBed.inject(DesktopMenuService);
      expect(() => service.run({ type: 'navigate', id: 'nope' })).not.toThrow();
      expect(() => service.run({ type: 'page-action', id: '7' })).not.toThrow();
    });

    it('ignores clicks while signed out', () => {
      const rename = vi.fn();
      menuActions.set([{ icon: 'edit', label: 'Rename', action: rename }]);
      currentUser.set(null);
      const service = TestBed.inject(DesktopMenuService);

      service.run({ type: 'navigate', id: 'thoughts' });
      service.run({ type: 'page-action', id: '0' });
      service.run({ type: 'open', kind: 'chapter', id: 'c1' });
      service.run({ type: 'sign-out' });

      expect(navigation.find('thoughts')!.run).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(navigation.openChapter).not.toHaveBeenCalled();
      expect(navigation.signOut).not.toHaveBeenCalled();
    });

    it('stops listening when the app is torn down', () => {
      const { unsubscribe } = installBridge();
      TestBed.inject(DesktopMenuService).start();
      TestBed.resetTestingModule();
      expect(unsubscribe).toHaveBeenCalled();
    });
  });
});
