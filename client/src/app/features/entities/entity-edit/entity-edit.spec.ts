import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { EMPTY, of, throwError } from 'rxjs';
import { Entity } from '@shared/models/entity.model';
import { EntityEditComponent } from './entity-edit';
import { EntityService } from '../entity.service';
import { EntityQuoteService } from '../entity-quote.service';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { ReadAloudService } from '@app/core/read-aloud/read-aloud.service';

/** Any method called on it returns an observable that never emits, so stray loads leave the test's state alone. */
function stubService<T>(overrides: Partial<Record<keyof T, unknown>> = {}): T {
  return new Proxy(overrides, {
    get: (target, prop) => (prop in target ? target[prop as keyof T] : () => EMPTY),
  }) as T;
}

const ENTITY = { id: 'e1', name: 'Ada', type: 'PERSON', seriesId: 's1' } as Entity;

describe('EntityEditComponent profile photo', () => {
  let setProfilePhoto: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setProfilePhoto = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: EntityService, useValue: stubService<EntityService>({ setProfilePhoto }) },
        { provide: EntityQuoteService, useValue: stubService<EntityQuoteService>() },
        {
          provide: UserSettingsService,
          useValue: stubService<UserSettingsService>({
            genderOptions: signal([]),
            raceOptions: signal([]),
            orientationOptions: signal([]),
          }),
        },
        { provide: MatDialog, useValue: stubService<MatDialog>() },
        { provide: Router, useValue: stubService<Router>() },
      ],
    });
  });

  function create(entity: Entity, isNew: boolean) {
    const fixture = TestBed.createComponent(EntityEditComponent);
    fixture.componentRef.setInput('entity', entity);
    fixture.componentRef.setInput('isNew', isNew);
    TestBed.tick();
    return fixture.componentInstance;
  }

  it('saves the photo straight away on an existing entity and reports the stored entity', () => {
    const saved = { ...ENTITY, thumbnailUrl: 'https://blob/t.png', originalUrl: 'https://blob/o.png' };
    setProfilePhoto.mockReturnValue(of(saved));
    const cmp = create(ENTITY, false);
    const emitted: Entity[] = [];
    cmp.photoSaved.subscribe(e => emitted.push(e));

    cmp.setProfilePhoto('https://blob/o.png', 'https://blob/t.png');

    expect(setProfilePhoto).toHaveBeenCalledWith('e1', 'https://blob/o.png', 'https://blob/t.png');
    expect(emitted).toEqual([saved]);
    expect(cmp.draft()?.thumbnailUrl).toBe('https://blob/t.png');
    expect(cmp.draft()?.originalUrl).toBe('https://blob/o.png');
  });

  it('keeps other unsaved edits in the draft', () => {
    setProfilePhoto.mockReturnValue(of(ENTITY));
    const cmp = create(ENTITY, false);
    cmp.update('name', 'Ada Lovelace');

    cmp.setProfilePhoto('https://blob/o.png', 'https://blob/t.png');

    expect(cmp.draft()?.name).toBe('Ada Lovelace');
  });

  it('does not save the photo for a new entity', () => {
    const cmp = create(ENTITY, true);
    cmp.setProfilePhoto('https://blob/o.png', 'https://blob/t.png');
    expect(setProfilePhoto).not.toHaveBeenCalled();
    expect(cmp.draft()?.thumbnailUrl).toBe('https://blob/t.png');
  });

  it('does not save the photo for an entity without an id', () => {
    const cmp = create({ ...ENTITY, id: '' }, false);
    cmp.setProfilePhoto('https://blob/o.png', 'https://blob/t.png');
    expect(setProfilePhoto).not.toHaveBeenCalled();
  });

  it('keeps the photo in the draft when the save fails, so Save still applies it', () => {
    setProfilePhoto.mockReturnValue(throwError(() => new Error('offline')));
    const cmp = create(ENTITY, false);
    const emitted: Entity[] = [];
    cmp.photoSaved.subscribe(e => emitted.push(e));

    cmp.setProfilePhoto('https://blob/o.png', 'https://blob/t.png');

    expect(emitted).toEqual([]);
    expect(cmp.draft()?.thumbnailUrl).toBe('https://blob/t.png');
  });
});

describe('EntityEditComponent read-aloud voice', () => {
  const ANDREW = {
    id: 'azure:en-US-AndrewNeural', name: 'Andrew', lang: 'en-US', localeName: 'English (United States)', quality: 'premium',
    provider: 'azure', gender: 'Male', hd: false, multilingual: false, personalities: [], scenarios: [],
  };
  let open: ReturnType<typeof vi.fn>;

  function setup(catalog: unknown[] = [ANDREW]) {
    open = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: EntityService, useValue: stubService<EntityService>() },
        { provide: EntityQuoteService, useValue: stubService<EntityQuoteService>() },
        {
          provide: UserSettingsService,
          useValue: stubService<UserSettingsService>({ genderOptions: signal([]), raceOptions: signal([]), orientationOptions: signal([]) }),
        },
        { provide: ReadAloudService, useValue: { azureCatalog: signal(catalog), loadVoices: vi.fn() } },
        { provide: MatDialog, useValue: { open } },
        { provide: Router, useValue: stubService<Router>() },
      ],
    });
  }

  function create(entity: Entity) {
    const fixture = TestBed.createComponent(EntityEditComponent);
    fixture.componentRef.setInput('entity', entity);
    TestBed.tick();
    return fixture.componentInstance;
  }

  it('names the voice, or the fallback for characters and the narrator', () => {
    setup();
    expect(create({ ...ENTITY, voiceId: ANDREW.id }).voiceName()).toBe('Andrew · English (United States)');
    expect(create(ENTITY).voiceName()).toBe('Narration voice');
    expect(create({ ...ENTITY, isNarrator: true }).voiceName()).toBe("The reader's own voice");
  });

  it('only offers voices when Microsoft voices are available', () => {
    setup([]);
    expect(create(ENTITY).voicesAvailable()).toBe(false);
  });

  it('sets the picked voice, clears it for the default, and keeps it when the dialog is dismissed', () => {
    setup();
    const cmp = create(ENTITY);
    open.mockReturnValueOnce({ afterClosed: () => of({ voiceId: ANDREW.id }) });
    cmp.chooseVoice();
    expect(open.mock.calls[0]![1].data).toEqual({ name: 'Ada', voiceId: null, isNarrator: false });
    expect(cmp.draft()!.voiceId).toBe(ANDREW.id);

    open.mockReturnValueOnce({ afterClosed: () => of(undefined) });
    cmp.chooseVoice();
    expect(cmp.draft()!.voiceId).toBe(ANDREW.id);

    open.mockReturnValueOnce({ afterClosed: () => of({ voiceId: null }) });
    cmp.chooseVoice();
    expect(cmp.draft()!.voiceId).toBeUndefined();
  });
});
