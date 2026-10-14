import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { Chapter } from '@shared/models/chapter.model';
import { AuthService, GoogleUser } from '@app/core/auth/auth.service';
import { ChapterService } from '@app/features/chapters/chapter.service';
import { ChapterDraftService } from './chapter-draft.service';
import { UnsavedDraftsService } from './unsaved-drafts.service';

const user: GoogleUser = { email: 'a@b.c', name: 'A', picture: '', idToken: 't' };
const chapter = (id: string) => ({ id, title: `Chapter ${id}` }) as Chapter;

describe('UnsavedDraftsService', () => {
  let currentUser: ReturnType<typeof signal<GoogleUser | null>>;
  let draftIds: ReturnType<typeof signal<ReadonlySet<string>>>;
  let getAll: ReturnType<typeof vi.fn>;
  let resolvePendingDraft: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    currentUser = signal<GoogleUser | null>(user);
    draftIds = signal<ReadonlySet<string>>(new Set());
    getAll = vi.fn(() => of([chapter('c1'), chapter('c2'), chapter('c3')]));
    // c2's draft matches the server, so it isn't really pending.
    resolvePendingDraft = vi.fn(async (c: Chapter) => (c.id === 'c2' ? null : { content: 'x' }));

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { currentUser } },
        { provide: ChapterService, useValue: { getAll } },
        { provide: ChapterDraftService, useValue: { draftIds, resolvePendingDraft } },
      ],
    });
  });

  async function settle(): Promise<void> {
    TestBed.tick();
    await new Promise(resolve => setTimeout(resolve));
  }

  it('lists only chapters whose drafts are really pending', async () => {
    draftIds.set(new Set(['c1', 'c2']));
    const service = TestBed.inject(UnsavedDraftsService);
    await settle();

    expect(service.chapters().map(c => c.id)).toEqual(['c1']);
    expect(resolvePendingDraft).toHaveBeenCalledTimes(2);
  });

  it('updates when a new draft appears', async () => {
    const service = TestBed.inject(UnsavedDraftsService);
    await settle();
    expect(service.chapters()).toEqual([]);

    draftIds.set(new Set(['c3']));
    await settle();
    expect(service.chapters().map(c => c.id)).toEqual(['c3']);
  });

  it('does not fetch chapters until signed in, and clears them on sign-out', async () => {
    currentUser.set(null);
    draftIds.set(new Set(['c1']));
    const service = TestBed.inject(UnsavedDraftsService);
    await settle();
    expect(getAll).not.toHaveBeenCalled();
    expect(service.chapters()).toEqual([]);

    currentUser.set(user);
    await settle();
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(service.chapters().map(c => c.id)).toEqual(['c1']);

    currentUser.set(null);
    await settle();
    expect(service.chapters()).toEqual([]);
  });

  it('stays empty when the chapters fail to load', async () => {
    getAll.mockReturnValue(throwError(() => new Error('offline')));
    draftIds.set(new Set(['c1']));
    const service = TestBed.inject(UnsavedDraftsService);
    await settle();
    expect(service.chapters()).toEqual([]);
  });

  it('ignores a slow fetch that is still in flight', async () => {
    getAll.mockReturnValue(new Subject<Chapter[]>());
    draftIds.set(new Set(['c1']));
    const service = TestBed.inject(UnsavedDraftsService);
    await settle();
    expect(service.chapters()).toEqual([]);
  });
});
