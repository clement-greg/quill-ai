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
