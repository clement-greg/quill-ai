import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { Entity } from '@shared/models/entity.model';
import { EntityPanelService } from './entity-panel.service';
import { EntityService } from './entity.service';
import { SeriesService } from '../series/series.service';

const COLLAPSED_KEY = 'entityPanel.collapsedGroups';
const LAST_SERIES_KEY = 'entityPanel.lastSeriesId';

function makeEntity(overrides: Partial<Entity>): Entity {
  return { id: 'e-1', name: 'Arthur', type: 'PERSON', seriesId: 's-1', ...overrides };
}

describe('EntityPanelService', () => {
  let entityStub: Record<string, ReturnType<typeof vi.fn>>;
  let seriesStub: { getAll: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    localStorage.clear();
    entityStub = {
      getBySeries: vi.fn(() => of([])),
      getArchivedBySeries: vi.fn(() => of([])),
      getOrCreateNarrator: vi.fn(() => of(makeEntity({ id: 'narrator', isNarrator: true }))),
      reorder: vi.fn(() => of(void 0)),
      getById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
    };
    seriesStub = { getAll: vi.fn(() => of([])) };

    TestBed.configureTestingModule({
      providers: [
        { provide: EntityService, useValue: entityStub },
        { provide: SeriesService, useValue: seriesStub },
      ],
    });
  });

  function inject(): EntityPanelService {
    return TestBed.inject(EntityPanelService);
  }

  describe('collapsed-group persistence', () => {
    it('restores collapsed groups from localStorage', () => {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['PLACE']));
      expect(inject().isGroupCollapsed('PLACE')).toBe(true);
      expect(inject().isGroupCollapsed('PERSON')).toBe(false);
    });

    it('falls back to nothing collapsed when the stored value is corrupt', () => {
      localStorage.setItem(COLLAPSED_KEY, 'not json {');
      expect(inject().collapsedGroups().size).toBe(0);
    });

    it('toggleGroup persists the new state', () => {
      const service = inject();
      service.toggleGroup('THING');
      expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual(['THING']);
      service.toggleGroup('THING');
      expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual([]);
    });
  });

  describe('entityGroups', () => {
    it('groups entities by type in PERSON/PLACE/THING order, omitting empty groups', () => {
      const service = inject();
      service.entityList.set([
        makeEntity({ id: 't1', type: 'THING' }),
        makeEntity({ id: 'p1', type: 'PERSON' }),
        makeEntity({ id: 'p2', type: 'PERSON' }),
      ]);
      const groups = service.entityGroups();
      expect(groups.map(g => g.type)).toEqual(['PERSON', 'THING']);
      expect(groups[0].entities.map(e => e.id)).toEqual(['p1', 'p2']);
    });
  });

  describe('loadEntities', () => {
    it('excludes the narrator and sorts by sortOrder with unordered items last', () => {
      entityStub['getBySeries'].mockReturnValue(
        of([
          makeEntity({ id: 'unordered' }),
          makeEntity({ id: 'second', sortOrder: 2 }),
          makeEntity({ id: 'narrator', isNarrator: true }),
          makeEntity({ id: 'first', sortOrder: 1 }),
        ]),
      );
      const service = inject();
      service.loadEntities('s-1');
      expect(service.entityList().map(e => e.id)).toEqual(['first', 'second', 'unordered']);
      expect(service.entityLoading()).toBe(false);
    });
  });

  describe('loadAllSeries auto-select', () => {
    const twoSeries = [
      { id: 's-a', title: 'Alpha' },
      { id: 's-b', title: 'Beta' },
    ];

    it('selects the remembered series when it still exists', () => {
      localStorage.setItem(LAST_SERIES_KEY, 's-b');
      seriesStub.getAll.mockReturnValue(of(twoSeries));
      const service = inject();
      service.loadAllSeries();
      expect(service.seriesId()).toBe('s-b');
      expect(entityStub['getBySeries']).toHaveBeenCalledWith('s-b');
    });

    it('ignores a remembered series that no longer exists', () => {
      localStorage.setItem(LAST_SERIES_KEY, 's-gone');
      seriesStub.getAll.mockReturnValue(of(twoSeries));
      const service = inject();
      service.loadAllSeries();
      expect(service.seriesId()).toBeNull();
    });

    it('auto-selects the only series when there is exactly one', () => {
      seriesStub.getAll.mockReturnValue(of([{ id: 's-only', title: 'Solo' }]));
      const service = inject();
      service.loadAllSeries();
      expect(service.seriesId()).toBe('s-only');
    });

    it('prefers an explicit id over the remembered one', () => {
      localStorage.setItem(LAST_SERIES_KEY, 's-b');
      seriesStub.getAll.mockReturnValue(of(twoSeries));
      const service = inject();
      service.loadAllSeries('s-a');
      expect(service.seriesId()).toBe('s-a');
    });

    it('hides archived/deleted series and sorts by title', () => {
      seriesStub.getAll.mockReturnValue(
        of([
          { id: 's-z', title: 'Zulu' },
          { id: 's-x', title: 'Gone', deleted: true },
          { id: 's-y', title: 'Old', archived: true },
          { id: 's-a', title: 'Alpha' },
        ]),
      );
      const service = inject();
      service.loadAllSeries();
      expect(service.allSeries().map(s => s.id)).toEqual(['s-a', 's-z']);
    });
  });

  describe('reorderWithinGroup', () => {
    it('reorders within one type while keeping other types in place', () => {
      const service = inject();
      service.entityList.set([
        makeEntity({ id: 'p1', type: 'PERSON' }),
        makeEntity({ id: 'place1', type: 'PLACE' }),
        makeEntity({ id: 'p2', type: 'PERSON' }),
        makeEntity({ id: 'p3', type: 'PERSON' }),
      ]);

      service.reorderWithinGroup('PERSON', 0, 2); // p1 → end of the PERSON group

      expect(service.entityList().map(e => e.id)).toEqual(['p2', 'place1', 'p3', 'p1']);
      expect(entityStub['reorder']).toHaveBeenCalledWith(['p2', 'place1', 'p3', 'p1']);
    });
  });

  describe('proxyUrl', () => {
    it('rewrites a blob URL to the image proxy by filename', () => {
      expect(inject().proxyUrl('https://store.example.com/photos/abc123.png')).toBe('/api/image/abc123.png');
    });

    it('returns null for a missing url', () => {
      expect(inject().proxyUrl(undefined)).toBeNull();
      expect(inject().proxyUrl('')).toBeNull();
    });
  });

  describe('panelWidth', () => {
    it('widens while editing an entity', () => {
      const service = inject();
      expect(service.panelWidth).toBe(340);
      service.editingEntity.set(makeEntity({}));
      expect(service.panelWidth).toBe(572);
    });
  });
});
