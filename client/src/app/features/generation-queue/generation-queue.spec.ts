import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { provideRouter } from '@angular/router';
import { NEVER, of, Subject, throwError } from 'rxjs';
import { HeaderService } from '@app/core/services/header.service';
import { EntityService } from '@app/features/entities/entity.service';
import { GenerationQueueComponent } from './generation-queue';
import { GenerationQueueService } from './generation-queue.service';
import { TrackedGenerationJob } from '@shared/models/generation-job.model';
import { NewGenerationDialogComponent, NewGenerationRequest, NewGenerationResult } from './new-generation-dialog';

const JOB = { promptId: 'p-1', seed: 1, queueNumber: 0, frames: null, count: 1, tracked: true };

describe('GenerationQueueComponent — new generation', () => {
  let dialogResult: NewGenerationResult | undefined;
  let opened: unknown[];
  let entityService: Record<string, ReturnType<typeof vi.fn>>;
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let queueService: Record<string, ReturnType<typeof vi.fn>>;

  const source = (chosen: NewGenerationRequest): NewGenerationResult => ({
    ...chosen,
    file: new File([new Uint8Array(4)], 'pic.png', { type: 'image/png' }),
    entity: { id: 'e-1', name: 'Janet' },
  });

  function create() {
    TestBed.configureTestingModule({
      imports: [GenerationQueueComponent],
      providers: [
        provideRouter([]),
        {
          provide: MatDialog,
          useValue: {
            open: (component: unknown) => {
              opened.push(component);
              return { afterClosed: () => of(dialogResult) };
            },
          },
        },
        { provide: MatSnackBar, useValue: snackBar },
        { provide: EntityService, useValue: entityService },
        { provide: GenerationQueueService, useValue: queueService },
        { provide: HeaderService, useValue: { setPage: vi.fn() } },
      ],
    });
    // No detectChanges: ngOnInit would start the queue poll, which these tests
    // don't need.
    return TestBed.createComponent(GenerationQueueComponent).componentInstance;
  }

  beforeEach(() => {
    dialogResult = undefined;
    opened = [];
    snackBar = { open: vi.fn(() => ({ onAction: () => new Subject() })) };
    entityService = {
      uploadFrame: vi.fn(() => of({ url: 'https://blob.test/frame.png' })),
      generateVideo: vi.fn(() => of(JOB)),
      generateImagesFromPhoto: vi.fn(() => of(JOB)),
      clothesSwap: vi.fn(() => of(JOB)),
    };
    queueService = {
      getTrackedJobs: vi.fn(() => of({ jobs: [] })),
      // Never answers, so the screen stays loading if change detection runs
      // while a test awaits the failure toast.
      getStatus: vi.fn(() => NEVER),
    };
  });

  it('does nothing when the dialog is cancelled', () => {
    create().newGeneration();
    expect(opened).toEqual([NewGenerationDialogComponent]);
    expect(entityService['uploadFrame']).not.toHaveBeenCalled();
  });

  it('uploads the image and queues a video onto the entity', () => {
    dialogResult = source({ kind: 'video', request: { prompt: 'she waves', durationSeconds: 3 } });

    create().newGeneration();

    expect(entityService['uploadFrame']).toHaveBeenCalledWith(dialogResult.file);
    expect(entityService['generateVideo']).toHaveBeenCalledWith('https://blob.test/frame.png', 'she waves', 3, 'e-1');
    expect(queueService['getTrackedJobs']).toHaveBeenCalled();
    expect(snackBar.open).toHaveBeenLastCalledWith(
      '3.0s video queued for Janet — added there, hidden, when finished', 'Dismiss', { duration: 5000 }
    );
  });

  it('queues images with every setting the form gave', () => {
    const request = { prompt: 'a portrait', count: 4, negativePrompt: 'blurry', steps: 30 };
    dialogResult = source({ kind: 'images', request });

    create().newGeneration();

    expect(entityService['generateImagesFromPhoto']).toHaveBeenCalledWith('https://blob.test/frame.png', request, 'e-1');
  });

  it('queues a clothes swap', () => {
    const request = { prompt: 'a red coat', count: 2 };
    dialogResult = source({ kind: 'clothes-swap', request });

    create().newGeneration();

    expect(entityService['clothesSwap']).toHaveBeenCalledWith('https://blob.test/frame.png', request, 'e-1');
  });

  it('says how many were queued when the receiver failed partway', () => {
    entityService['clothesSwap'] = vi.fn(() => of({ ...JOB, count: 2, error: 'out of memory' }));
    dialogResult = source({ kind: 'clothes-swap', request: { prompt: 'a red coat', count: 4 } });

    create().newGeneration();

    expect(snackBar.open).toHaveBeenLastCalledWith(
      expect.stringMatching(/Clothes swap \(4 images\): only 2 queued for Janet.*The rest failed: out of memory/),
      'Dismiss'
    );
  });

  it('says so, and queues nothing, when the image will not upload', () => {
    entityService['uploadFrame'] = vi.fn(() =>
      throwError(() => new HttpErrorResponse({ status: 400, error: { error: 'A frame must be an image' } }))
    );
    dialogResult = source({ kind: 'video', request: { prompt: 'she waves', durationSeconds: 3 } });
    const component = create();

    component.newGeneration();

    expect(entityService['generateVideo']).not.toHaveBeenCalled();
    expect(component.starting()).toBe(false);
    expect(snackBar.open).toHaveBeenCalledWith(
      'Could not use that image: A frame must be an image', 'Dismiss', { duration: 6000 }
    );
  });

  it('offers a retry when the receiver is unreachable, and retries on request', async () => {
    const action = new Subject<void>();
    snackBar.open = vi.fn(() => ({ onAction: () => action }));
    entityService['clothesSwap'] = vi.fn(() =>
      throwError(() => new HttpErrorResponse({ status: 502, error: { error: 'Receiver offline' } }))
    );
    dialogResult = source({ kind: 'clothes-swap', request: { prompt: 'a hat', count: 1 } });

    create().newGeneration();

    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenLastCalledWith(
        expect.stringMatching(/^Clothes swap \(1 image\) failed: Receiver offline/), 'Retry'
      )
    );
    action.next();
    expect(entityService['clothesSwap']).toHaveBeenCalledTimes(2);
    // The image is already stored; a retry sends the same one again.
    expect(entityService['uploadFrame']).toHaveBeenCalledTimes(1);
  });

  it('does not offer a retry for a request the server rejected', async () => {
    entityService['generateImagesFromPhoto'] = vi.fn(() =>
      throwError(() => new HttpErrorResponse({ status: 400, error: { error: 'A prompt is required' } }))
    );
    dialogResult = source({ kind: 'images', request: { prompt: 'x', count: 1 } });

    create().newGeneration();

    await vi.waitFor(() =>
      expect(snackBar.open).toHaveBeenLastCalledWith(
        expect.stringMatching(/^1 image failed: A prompt is required/), 'Dismiss'
      )
    );
  });

  it('will not start a second generation while an image is uploading', () => {
    const component = create();
    component.starting.set(true);
    component.newGeneration();
    expect(opened).toHaveLength(0);
  });
});

describe('GenerationQueueComponent — dismissing a finished job', () => {
  let tracked: TrackedGenerationJob[];
  let dismiss$: Subject<void>;
  let snackBar: { open: ReturnType<typeof vi.fn> };
  let queueService: Record<string, ReturnType<typeof vi.fn>>;

  const job = (id: string, state: TrackedGenerationJob['state']): TrackedGenerationJob => ({
    id,
    kind: 'images',
    entityId: 'e-1',
    entityName: 'Janet',
    state,
    requestedCount: 1,
    queuedAt: '2026-10-06T12:00:00Z',
    attempts: 1,
  } as TrackedGenerationJob);

  function render() {
    TestBed.configureTestingModule({
      imports: [GenerationQueueComponent],
      providers: [
        provideRouter([]),
        { provide: MatDialog, useValue: { open: vi.fn() } },
        { provide: MatSnackBar, useValue: snackBar },
        { provide: EntityService, useValue: {} },
        { provide: GenerationQueueService, useValue: queueService },
        { provide: HeaderService, useValue: { setPage: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(GenerationQueueComponent);
    fixture.detectChanges();
    // The poll would re-read the list mid-test; one read on init is all these need.
    fixture.componentInstance.ngOnDestroy();
    return fixture;
  }

  const cards = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('.tracked-card'));
  const dismissButton = (card: HTMLElement) =>
    card.querySelector<HTMLButtonElement>('[aria-label="Dismiss this job"]')!;

  beforeEach(() => {
    tracked = [job('a', 'collected'), job('b', 'failed')];
    dismiss$ = new Subject<void>();
    snackBar = { open: vi.fn() };
    queueService = {
      getTrackedJobs: vi.fn(() => of({ jobs: tracked })),
      // Offline receiver: keeps the queue half of the screen out of these tests.
      getStatus: vi.fn(() => throwError(() => new HttpErrorResponse({ status: 503 }))),
      dismissTrackedJob: vi.fn(() => dismiss$),
    };
  });

  // The leave animations themselves can't run here: Angular only enables
  // animate.leave where the DOM has getAnimations(), which jsdom lacks. These
  // pin down when a card leaves, which is what decides when it animates.
  it('removes the card only once the server lets go of the job', () => {
    const fixture = render();
    const el: HTMLElement = fixture.nativeElement;
    const [first] = cards(el);

    dismissButton(first).click();
    fixture.detectChanges();
    // Nothing moves until the server agrees — a failed dismiss must leave it be.
    expect(first.isConnected).toBe(true);
    expect(queueService['dismissTrackedJob']).toHaveBeenCalledWith('a');

    dismiss$.next();
    dismiss$.complete();
    fixture.detectChanges();
    expect(first.isConnected).toBe(false);
    expect(cards(el).map(c => c.textContent)).toEqual([expect.stringContaining('Failed')]);
  });

  it('keeps the card when the dismiss fails', () => {
    const fixture = render();
    const el: HTMLElement = fixture.nativeElement;
    const [first] = cards(el);

    dismissButton(first).click();
    dismiss$.error(new HttpErrorResponse({ status: 500 }));
    fixture.detectChanges();

    expect(first.isConnected).toBe(true);
    expect(cards(el)).toHaveLength(2);
    expect(snackBar.open).toHaveBeenCalledWith('Could not dismiss that job.', undefined, { duration: 3000 });
  });

  it('takes the whole section away when the last job is dismissed', () => {
    tracked = [job('a', 'collected')];
    const fixture = render();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('section.tracked')).not.toBeNull();

    dismissButton(cards(el)[0]).click();
    dismiss$.next();
    dismiss$.complete();
    fixture.detectChanges();
    expect(el.querySelector('section.tracked')).toBeNull();
  });
});
