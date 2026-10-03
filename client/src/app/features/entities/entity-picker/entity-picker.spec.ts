import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { Entity } from '@shared/models/entity.model';
import { Series } from '@shared/models/series.model';
import { SeriesService } from '@app/features/series/series.service';
import { SeriesContextService } from '@app/core/services/series-context.service';
import { EntityService } from '../entity.service';
import { EntityPickerComponent, entityImageSrc } from './entity-picker';

describe('entityImageSrc', () => {
  it('routes a stored image through the image proxy', () => {
    expect(entityImageSrc('https://blob.test/container/abc_thumb.webp')).toBe('/api/image/abc_thumb.webp');
  });

  it('has nothing to show for an entity without a picture', () => {
    expect(entityImageSrc(undefined)).toBeNull();
    expect(entityImageSrc('')).toBeNull();
  });
});

const SERIES = [
  { id: 's-1', title: 'First' },
  { id: 's-2', title: 'Second' },
  { id: 's-old', title: 'Old', archived: true },
] as Series[];

const entity = (id: string, name: string, extra: Partial<Entity> = {}) =>
  ({ id, name, type: 'PERSON', seriesId: 's-1', ...extra }) as Entity;

describe('EntityPickerComponent', () => {
  let getBySeries: ReturnType<typeof vi.fn>;
  let currentSeriesId: string | null;

  function create(initialSeriesId: string | null = null) {
    TestBed.configureTestingModule({
      imports: [EntityPickerComponent],
      providers: [
        { provide: SeriesService, useValue: { getAll: () => of(SERIES) } },
        { provide: EntityService, useValue: { getBySeries } },
        { provide: SeriesContextService, useValue: { currentSeriesId: () => currentSeriesId } },
      ],
    });
    const fixture = TestBed.createComponent(EntityPickerComponent);
    fixture.componentRef.setInput('initialSeriesId', initialSeriesId);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    currentSeriesId = null;
    getBySeries = vi.fn(() =>
      of([
        entity('e-2', 'Zelda'),
        entity('e-1', 'Arthur'),
        entity('e-3', 'Gone', { archived: true }),
        entity('e-4', 'Binned', { deleted: true }),
      ])
    );
  });

  it('starts on the series in context and hides archived series', () => {
    currentSeriesId = 's-2';
    const { componentInstance: picker } = create();
    expect(picker.series().map(s => s.id)).toEqual(['s-1', 's-2']);
    expect(picker.seriesId()).toBe('s-2');
    expect(getBySeries).toHaveBeenCalledWith('s-2');
  });

  it('prefers the series it was given over the one in context', () => {
    currentSeriesId = 's-2';
    expect(create('s-1').componentInstance.seriesId()).toBe('s-1');
  });

  it('falls back to the first series when the one in context is unknown', () => {
    currentSeriesId = 'nope';
    expect(create().componentInstance.seriesId()).toBe('s-1');
  });

  it('lists live entities alphabetically and filters by name', () => {
    const { componentInstance: picker } = create();
    expect(picker.filteredEntities().map(e => e.name)).toEqual(['Arthur', 'Zelda']);
    picker.search.set('zel');
    expect(picker.filteredEntities().map(e => e.name)).toEqual(['Zelda']);
  });

  it('selects an entity when its row is clicked', () => {
    const fixture = create();
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.entity-row');
    rows[1].click();
    expect(fixture.componentInstance.selected()).toEqual({ id: 'e-2', name: 'Zelda' });
  });

  it("carries the entity's profile picture with the pick", () => {
    const { componentInstance: picker } = create();
    picker.pick(entity('e-5', 'Janet', { thumbnailUrl: 'https://blob.test/janet_thumb.webp' }));
    expect(picker.selected()).toEqual({
      id: 'e-5',
      name: 'Janet',
      thumbnailUrl: 'https://blob.test/janet_thumb.webp',
    });
  });

  it('clears the selection when the series changes', () => {
    const { componentInstance: picker } = create();
    picker.selected.set({ id: 'e-1', name: 'Arthur' });
    picker.onSeriesChange('s-2');
    expect(picker.selected()).toBeNull();
    expect(getBySeries).toHaveBeenLastCalledWith('s-2');
  });

  it('shows an empty list when the entities cannot be read', () => {
    const failing = new Subject<Entity[]>();
    getBySeries = vi.fn(() => failing);
    const { componentInstance: picker } = create();
    expect(picker.loading()).toBe(true);
    failing.error(new Error('down'));
    expect(picker.loading()).toBe(false);
    expect(picker.filteredEntities()).toEqual([]);
  });
});
