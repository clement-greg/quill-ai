import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { EMPTY, Subject, of } from 'rxjs';
import { Entity } from '@shared/models/entity.model';
import { EntityDetailComponent } from './entity-detail';
import { EntityService } from '../entity.service';
import { TimelineEventService } from '../timeline-event.service';
import { EntityRelationshipService } from '../entity-relationship.service';
import { MapService } from '@app/features/maps/map.service';
import { UserSettingsService } from '@app/core/services/user-settings.service';

/** Any method called on it returns an observable that never emits, so stray loads leave the test's state alone. */
function stubService<T>(overrides: Partial<Record<keyof T, unknown>> = {}): T {
  return new Proxy(overrides, {
    get: (target, prop) => (prop in target ? target[prop as keyof T] : () => EMPTY),
  }) as T;
}

function entityWith(urls: string[], id = 'e1'): Entity {
  return { id, name: 'Ada', type: 'PERSON', seriesId: 's1', photos: urls.map(url => ({ url })) } as Entity;
}

describe('EntityDetailComponent lightbox removal', () => {
  let removePhoto: ReturnType<typeof vi.fn>;
  let setPhotosHidden: ReturnType<typeof vi.fn>;
  let snackOpen: ReturnType<typeof vi.fn>;
  const showHiddenPhotos = signal(false);

  beforeEach(() => {
    vi.useFakeTimers();
    removePhoto = vi.fn();
    setPhotosHidden = vi.fn();
    snackOpen = vi.fn();
    showHiddenPhotos.set(false);
    TestBed.configureTestingModule({
      providers: [
        { provide: EntityService, useValue: stubService<EntityService>({ removePhoto, setPhotosHidden }) },
        { provide: TimelineEventService, useValue: stubService<TimelineEventService>() },
        { provide: EntityRelationshipService, useValue: stubService<EntityRelationshipService>() },
        { provide: MapService, useValue: stubService<MapService>() },
        { provide: MatDialog, useValue: stubService<MatDialog>() },
        { provide: MatSnackBar, useValue: { open: snackOpen } },
        { provide: UserSettingsService, useValue: stubService<UserSettingsService>({ showHiddenPhotos }) },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  function openOn(urls: string[], index: number) {
    const fixture = TestBed.createComponent(EntityDetailComponent);
    fixture.componentRef.setInput('entityId', 'e1');
    const cmp = fixture.componentInstance;
    cmp.entity.set(entityWith(urls));
    cmp.openLightbox(index);
    cmp.lightboxMediaLoaded.set(true);
    return cmp;
  }

  it('plays the exit before swapping in the next photo, even when the server answers at once', () => {
    removePhoto.mockReturnValue(of(entityWith(['a', 'c'])));
    const cmp = openOn(['a', 'b', 'c'], 1);
    const keyBefore = cmp.lightboxKey();

    cmp.lightboxDelete();
    expect(cmp.removalState()).toBe('exiting');
    expect(cmp.currentLightboxPhoto()?.url).toBe('b');

    vi.advanceTimersByTime(399);
    expect(cmp.currentLightboxPhoto()?.url).toBe('b');
    vi.advanceTimersByTime(1);
    expect(cmp.removingPhoto()).toBe(false);
    expect(cmp.currentLightboxPhoto()?.url).toBe('c');
    expect(cmp.lightboxKey()).toBe(keyBefore + 1);
    expect(cmp.slideDir()).toBe('next');
    expect(cmp.lightboxMediaLoaded()).toBe(false);
  });

  it('shows the working state for as long as a slow server takes, then exits', () => {
    const response = new Subject<Entity>();
    removePhoto.mockReturnValue(response);
    const cmp = openOn(['a', 'b'], 0);

    cmp.lightboxDelete();
    expect(cmp.removalState()).toBe('working');
    expect(cmp.removalLabel()).toBe('Deleting…');
    expect(cmp.deletingPhoto()).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(cmp.removalState()).toBe('working');

    response.next(entityWith(['b']));
    response.complete();
    expect(cmp.removalState()).toBe('exiting');
    expect(cmp.currentLightboxPhoto()?.url).toBe('a');

    vi.advanceTimersByTime(400);
    expect(cmp.removalState()).toBe('idle');
    expect(cmp.currentLightboxPhoto()?.url).toBe('b');
  });

  it('ignores a second press while the first delete is in flight', () => {
    removePhoto.mockReturnValue(new Subject<Entity>());
    const cmp = openOn(['a', 'b'], 0);

    cmp.lightboxDelete();
    cmp.lightboxDelete();
    expect(removePhoto).toHaveBeenCalledTimes(1);
  });

  it('closes the lightbox when the last photo is deleted', () => {
    removePhoto.mockReturnValue(of(entityWith([])));
    const cmp = openOn(['a'], 0);

    cmp.lightboxDelete();
    vi.advanceTimersByTime(400);
    expect(cmp.lightboxOpen()).toBe(false);
  });

  it('restores the photo and reports when the delete fails', () => {
    const response = new Subject<Entity>();
    removePhoto.mockReturnValue(response);
    const cmp = openOn(['a', 'b'], 0);

    cmp.lightboxDelete();
    response.error(new Error('boom'));
    expect(cmp.removalState()).toBe('idle');
    expect(cmp.currentLightboxPhoto()?.url).toBe('a');
    expect(snackOpen).toHaveBeenCalledWith('Delete failed', undefined, { duration: 4000 });
  });

  it('labels a hide as hiding and leaves the Delete button alone', () => {
    setPhotosHidden.mockReturnValue(new Subject<Entity>());
    const cmp = openOn(['a', 'b'], 0);

    cmp.lightboxHide();
    expect(cmp.removalState()).toBe('working');
    expect(cmp.removalLabel()).toBe('Hiding…');
    expect(cmp.deletingPhoto()).toBe(false);
  });

  it('animates a hide away when hidden photos are not shown', () => {
    setPhotosHidden.mockReturnValue(of(entityWith(['a', 'b'])));
    const cmp = openOn(['a', 'b'], 0);

    cmp.lightboxHide();
    expect(cmp.removalState()).toBe('exiting');
    vi.advanceTimersByTime(400);
    expect(cmp.removalState()).toBe('idle');
  });

  it('hides in place without an exit when hidden photos are shown', () => {
    showHiddenPhotos.set(true);
    setPhotosHidden.mockReturnValue(of(entityWith(['a', 'b'])));
    const cmp = openOn(['a', 'b'], 0);
    const keyBefore = cmp.lightboxKey();

    cmp.lightboxHide();
    expect(cmp.removingPhoto()).toBe(false);
    expect(cmp.lightboxKey()).toBe(keyBefore);
    expect(cmp.currentLightboxPhoto()?.url).toBe('a');
  });
});

describe('EntityDetailComponent lightbox keyboard', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: EntityService, useValue: stubService<EntityService>() },
        { provide: TimelineEventService, useValue: stubService<TimelineEventService>() },
        { provide: EntityRelationshipService, useValue: stubService<EntityRelationshipService>() },
        { provide: MapService, useValue: stubService<MapService>() },
        { provide: MatDialog, useValue: stubService<MatDialog>() },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: UserSettingsService, useValue: stubService<UserSettingsService>({ showHiddenPhotos: signal(false) }) },
      ],
    });
  });

  function openOn(urls: string[], index: number) {
    const fixture = TestBed.createComponent(EntityDetailComponent);
    fixture.componentRef.setInput('entityId', 'e1');
    const cmp = fixture.componentInstance;
    cmp.entity.set(entityWith(urls));
    cmp.openLightbox(index);
    return cmp;
  }

  function press(key: string, target: EventTarget = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it('pages with the arrow keys without the lightbox having focus', () => {
    const cmp = openOn(['a', 'b', 'c'], 1);

    const right = press('ArrowRight');
    expect(cmp.currentLightboxPhoto()?.url).toBe('c');
    expect(right.defaultPrevented).toBe(true);

    press('ArrowLeft');
    press('ArrowLeft');
    expect(cmp.currentLightboxPhoto()?.url).toBe('a');
  });

  it('wraps around at either end', () => {
    const cmp = openOn(['a', 'b'], 0);

    press('ArrowLeft');
    expect(cmp.currentLightboxPhoto()?.url).toBe('b');
    press('ArrowRight');
    expect(cmp.currentLightboxPhoto()?.url).toBe('a');
  });

  it('closes on Escape', () => {
    const cmp = openOn(['a', 'b'], 0);

    press('Escape');
    expect(cmp.lightboxOpen()).toBe(false);
  });

  it('does nothing while the lightbox is closed', () => {
    const cmp = openOn(['a', 'b'], 0);
    cmp.closeLightbox();

    const event = press('ArrowRight');
    expect(cmp.lightboxIndex()).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves keys typed into another element alone', () => {
    const cmp = openOn(['a', 'b'], 0);
    const input = document.createElement('input');
    document.body.appendChild(input);

    const event = press('ArrowRight', input);
    expect(cmp.currentLightboxPhoto()?.url).toBe('a');
    expect(event.defaultPrevented).toBe(false);
    input.remove();
  });

  it('leaves arrow keys to the video player controls', () => {
    const cmp = openOn(['a', 'b'], 0);
    const content = document.createElement('div');
    content.className = 'lightbox-content';
    const controls = document.createElement('div');
    controls.setAttribute('data-vp-controls', '');
    content.appendChild(controls);
    document.body.appendChild(content);

    press('ArrowRight', controls);
    expect(cmp.currentLightboxPhoto()?.url).toBe('a');
    content.remove();
  });
});

describe('EntityDetailComponent generated media landing', () => {
  let getById: ReturnType<typeof vi.fn>;
  let getOutstandingJobs: ReturnType<typeof vi.fn>;
  const job = { id: 'job1', kind: 'images', entityId: 'e1', state: 'running', requestedCount: 1 };

  beforeEach(() => {
    vi.useFakeTimers();
    // The gallery's lazy tiles watch the viewport; jsdom has no observer.
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    getById = vi.fn().mockReturnValue(of(entityWith(['a'])));
    getOutstandingJobs = vi.fn().mockReturnValue(of({ jobs: [job] }));
    TestBed.configureTestingModule({
      providers: [
        { provide: EntityService, useValue: stubService<EntityService>({ getById, getOutstandingJobs }) },
        { provide: TimelineEventService, useValue: stubService<TimelineEventService>() },
        { provide: EntityRelationshipService, useValue: stubService<EntityRelationshipService>() },
        { provide: MapService, useValue: stubService<MapService>() },
        { provide: MatDialog, useValue: stubService<MatDialog>() },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: UserSettingsService, useValue: stubService<UserSettingsService>({ showHiddenPhotos: signal(true) }) },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function load() {
    const fixture = TestBed.createComponent(EntityDetailComponent);
    fixture.componentRef.setInput('entityId', 'e1');
    TestBed.flushEffects();
    return fixture;
  }

  it('reloads in place, never swapping the page for the spinner, when a job lands', () => {
    const fixture = load();
    const cmp = fixture.componentInstance;
    expect(cmp.loading()).toBe(false);
    expect(cmp.outstandingJobs()).toHaveLength(1);

    getById.mockClear();
    const reload = new Subject<Entity>();
    getById.mockReturnValue(reload);
    getOutstandingJobs.mockReturnValue(of({ jobs: [] }));
    vi.advanceTimersByTime(15_000);

    expect(getById).toHaveBeenCalledTimes(1);
    expect(cmp.loading()).toBe(false);
    expect(cmp.entity()?.photos?.map(p => p.url)).toEqual(['a']);

    reload.next(entityWith(['a', 'b']));
    expect(cmp.loading()).toBe(false);
    expect(cmp.entity()?.photos?.map(p => p.url)).toEqual(['a', 'b']);
    fixture.destroy();
  });

  it('drops a background reload that answers after the user moved to another entity', () => {
    const fixture = load();
    const cmp = fixture.componentInstance;

    const reload = new Subject<Entity>();
    getById.mockReturnValue(reload);
    getOutstandingJobs.mockReturnValue(of({ jobs: [] }));
    vi.advanceTimersByTime(15_000);

    getById.mockReturnValue(of(entityWith(['z'], 'e2')));
    fixture.componentRef.setInput('entityId', 'e2');
    TestBed.flushEffects();
    reload.next(entityWith(['a', 'b']));

    expect(cmp.entity()?.id).toBe('e2');
    fixture.destroy();
  });
});
