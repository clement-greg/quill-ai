import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { AuthService } from '@app/core/auth/auth.service';
import { ExplorerService } from '@app/core/services/explorer.service';
import { SeriesContextService } from '@app/core/services/series-context.service';
import { AiAssistantService } from '@app/features/ai/ai-assistant.service';
import { AppNavigationService } from './app-navigation.service';

describe('AppNavigationService', () => {
  let navigate: ReturnType<typeof vi.fn>;
  let currentSeriesId: ReturnType<typeof signal<string | null>>;
  let auth: { signOut: ReturnType<typeof vi.fn> };
  let explorer: { reset: ReturnType<typeof vi.fn> };
  let aiAssistant: { togglePanel: ReturnType<typeof vi.fn> };
  let service: AppNavigationService;

  beforeEach(() => {
    navigate = vi.fn();
    currentSeriesId = signal<string | null>(null);
    auth = { signOut: vi.fn() };
    explorer = { reset: vi.fn() };
    aiAssistant = { togglePanel: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: Router, useValue: { navigate } },
        { provide: AuthService, useValue: auth },
        { provide: ExplorerService, useValue: explorer },
        { provide: SeriesContextService, useValue: { currentSeriesId } },
        { provide: AiAssistantService, useValue: aiAssistant },
      ],
    });
    service = TestBed.inject(AppNavigationService);
  });

  it('lists the explorer destinations in order', () => {
    expect(service.primary.map(i => i.label)).toEqual([
      'Resource Manager', 'Thoughts', 'Entities', 'Relationships', 'Maps', 'Photo Gallery', 'Archived Items', 'Generation Queue',
    ]);
    expect(service.secondary.map(i => i.label)).toEqual(['Writing Stats', 'Settings']);
  });

  it('gives every destination a unique id', () => {
    const ids = [...service.primary, ...service.secondary].map(i => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([
    ['thoughts', ['/thoughts']],
    ['entities', ['/entities']],
    ['maps', ['/maps']],
    ['gallery', ['/gallery']],
    ['archived', ['/archived']],
    ['generation-queue', ['/generation-queue']],
    ['writing-stats', ['/writing-stats']],
    ['settings', ['/settings']],
  ])('%s navigates to %j', (id, route) => {
    service.find(id)!.run();
    expect(navigate).toHaveBeenCalledWith(route);
  });

  it('Resource Manager toggles the assistant panel', () => {
    service.find('resource-manager')!.run();
    expect(aiAssistant.togglePanel).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('Relationships opens the current series diagram when there is one', () => {
    service.find('relationships')!.run();
    expect(navigate).toHaveBeenLastCalledWith(['/relationships']);

    currentSeriesId.set('s1');
    service.find('relationships')!.run();
    expect(navigate).toHaveBeenLastCalledWith(['/series', 's1', 'relationships']);
  });

  it('opens series, books, chapters and home', () => {
    service.openSeries('s1');
    service.openBook('b1');
    service.openChapter('c1');
    service.openHome();
    expect(navigate.mock.calls.map(c => c[0])).toEqual([
      ['/series', 's1'], ['/books', 'b1'], ['/chapters', 'c1', 'edit'], ['/series'],
    ]);
  });

  it('find returns undefined for an unknown id', () => {
    expect(service.find('nope')).toBeUndefined();
  });

  it('signs out: clears the explorer, the session, and goes to login', () => {
    service.signOut();
    expect(explorer.reset).toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });
});
