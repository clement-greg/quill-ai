import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { ThoughtsComponent } from './thoughts';
import { ThoughtsService, ThoughtPageQuery } from './thoughts.service';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { HeaderService } from '@app/core/services/header.service';
import { Thought, ThoughtPage } from '@shared/models/thought.model';

const thought = (id: string, tags: string[] = []): Thought => ({
  id,
  content: `content ${id}`,
  tags,
  modifiedAt: '2026-11-01T00:00:00.000Z',
});

describe('ThoughtsComponent', () => {
  let service: {
    getPage: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
  };
  let settings: { thoughtsPageSize: ReturnType<typeof signal<number>>; setThoughtsPageSize: ReturnType<typeof vi.fn> };
  let page: ThoughtPage;

  function create() {
    service = {
      getPage: vi.fn((_q: ThoughtPageQuery) => of(page)),
      create: vi.fn((t: Partial<Thought>) => of({ ...thought('new'), ...t })),
      update: vi.fn((id: string, t: Partial<Thought>) => of({ ...thought(id), ...t })),
      delete: vi.fn(() => of(undefined)),
      restore: vi.fn(() => of(thought('r'))),
    };
    const size = signal(50);
    settings = { thoughtsPageSize: size, setThoughtsPageSize: vi.fn((n: number) => size.set(n)) };
    TestBed.configureTestingModule({
      imports: [ThoughtsComponent],
      providers: [
        { provide: ThoughtsService, useValue: service },
        { provide: UserSettingsService, useValue: settings },
        { provide: HeaderService, useValue: { clearAll: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(ThoughtsComponent);
    fixture.detectChanges();
    return fixture;
  }

  const lastQuery = (): ThoughtPageQuery => service.getPage.mock.lastCall![0];

  beforeEach(() => {
    Element.prototype.scrollIntoView ??= vi.fn(); // jsdom lacks it
    page = {
      items: [thought('a', ['Plot']), thought('b')],
      total: 2,
      tags: [{ tag: 'Plot', count: 1 }, { tag: 'Quirk', count: 3 }],
    };
  });

  it('loads the first page at the remembered page size', () => {
    const fixture = create();
    expect(lastQuery()).toEqual({ tags: [], offset: 0, limit: 50 });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.thought-card').length).toBe(2);
    expect([...el.querySelectorAll('.filter-chip')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim()))
      .toEqual(['Plot 1', 'Quirk 3']);
  });

  it('toggling a filter tag reloads from the first page with that tag', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    c.pageIndex.set(2);
    c.toggleFilterTag('Quirk');
    expect(lastQuery()).toEqual({ tags: ['Quirk'], offset: 0, limit: 50 });
    expect(c.isTagSelected('quirk')).toBe(true);

    c.toggleFilterTag('QUIRK');
    expect(c.selectedTags()).toEqual([]);
  });

  it('clicking a tag on a card filters by it without opening the editor', () => {
    const fixture = create();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.thought-tag')!.click();
    expect(fixture.componentInstance.selectedTags()).toEqual(['Plot']);
    expect(fixture.componentInstance.showPanel()).toBe(false);
  });

  it('keeps a selected tag visible as a filter chip after no thought carries it', () => {
    const c = create().componentInstance;
    c.selectedTags.set(['Gone']);
    expect(c.filterTags().map((t) => t.tag)).toEqual(['Plot', 'Quirk', 'Gone']);
  });

  it('clearFilter resets the filter and reloads', () => {
    const c = create().componentInstance;
    c.toggleFilterTag('Plot');
    service.getPage.mockClear();
    c.clearFilter();
    expect(lastQuery().tags).toEqual([]);
    c.clearFilter();
    expect(service.getPage).toHaveBeenCalledTimes(1); // no-op when already clear
  });

  it('paging requests the right offset', () => {
    const c = create().componentInstance;
    c.onPage({ pageIndex: 3, pageSize: 50, length: 500 });
    expect(lastQuery()).toEqual({ tags: [], offset: 150, limit: 50 });
  });

  it('changing the page size remembers it and keeps the first visible thought in view', () => {
    const c = create().componentInstance;
    c.onPage({ pageIndex: 5, pageSize: 50, length: 1000 }); // showing 250–299
    c.onPage({ pageIndex: 5, pageSize: 100, length: 1000 });
    expect(settings.setThoughtsPageSize).toHaveBeenCalledWith(100);
    expect(lastQuery()).toEqual({ tags: [], offset: 200, limit: 100 });
  });

  it('steps back a page when the current page comes back empty', () => {
    const c = create().componentInstance;
    page = { items: [], total: 120, tags: [] };
    c.onPage({ pageIndex: 4, pageSize: 50, length: 250 });
    expect(c.pageIndex()).toBe(2);
    expect(lastQuery().offset).toBe(100);
  });

  it('ignores a stale response that arrives after a newer one', () => {
    const c = create().componentInstance;
    const slow = new Subject<ThoughtPage>();
    service.getPage.mockReturnValueOnce(slow);
    c.toggleFilterTag('Plot');
    c.toggleFilterTag('Quirk'); // second request answers immediately with `page`
    slow.next({ items: [thought('stale')], total: 1, tags: [] });
    expect(c.thoughts().map((t) => t.id)).toEqual(['a', 'b']);
  });

  describe('tag editor', () => {
    it('adds typed tags, splitting on commas, deduping, and reusing existing spellings', () => {
      const c = create().componentInstance;
      c.openEdit(thought('a', ['Plot']));
      const clear = vi.fn();
      c.addTag({ value: 'quirk, plot ,  new idea', chipInput: { clear } } as never);
      expect(c.editTags()).toEqual(['Plot', 'Quirk', 'new idea']);
      expect(clear).toHaveBeenCalled();
    });

    it('suggests known tags not already on the thought, matching the typed text', () => {
      const c = create().componentInstance;
      c.openEdit(thought('a', ['Plot']));
      expect(c.tagSuggestions()).toEqual(['Quirk']);
      c.tagQuery.set('xyz');
      expect(c.tagSuggestions()).toEqual([]);
    });

    it('removeTag drops a tag', () => {
      const c = create().componentInstance;
      c.openEdit(thought('a', ['Plot', 'Quirk']));
      c.removeTag('Plot');
      expect(c.editTags()).toEqual(['Quirk']);
    });

    it('saves the edited tags and reloads', () => {
      const c = create().componentInstance;
      c.openEdit(thought('a', ['Plot']));
      c.removeTag('Plot');
      service.getPage.mockClear();
      c.save();
      expect(service.update).toHaveBeenCalledWith('a', expect.objectContaining({ tags: [] }));
      expect(service.getPage).toHaveBeenCalled();
    });

    it('a new thought starts with the active filter tags and lands on page one', () => {
      const c = create().componentInstance;
      c.toggleFilterTag('Quirk');
      c.pageIndex.set(1);
      c.openNew();
      expect(c.editTags()).toEqual(['Quirk']);
      c.form.setValue({ title: '', content: 'hello' });
      c.save();
      expect(service.create).toHaveBeenCalledWith(expect.objectContaining({ tags: ['Quirk'], content: 'hello' }));
      expect(lastQuery().offset).toBe(0);
    });
  });

  it('shows a filter-specific empty state', () => {
    page = { items: [], total: 0, tags: [{ tag: 'Plot', count: 1 }] };
    const fixture = create();
    fixture.componentInstance.toggleFilterTag('Plot');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No thoughts have all of the selected tags');
  });
});
