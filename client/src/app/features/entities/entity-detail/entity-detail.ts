import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  OnDestroy,
  input,
  output,
  effect,
  viewChild,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { forkJoin, from, of, TimeoutError } from 'rxjs';
import { concatMap, map, catchError } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { CdkDropList, CdkDrag, CdkDragHandle, CdkDragDrop, CdkDragPlaceholder, moveItemInArray } from '@angular/cdk/drag-drop';
import { Entity, EntityPhoto, isVideoUrl } from '@shared/models/entity.model';
import { galleryMediaFrom, isGalleryMediaFile } from '@app/core/utils/gallery-media';
import { prepareImageForUpload } from '@app/core/utils/prepare-upload';
import { TrackedGenerationJob } from '@shared/models/generation-job.model';
import { TimelineEvent, TimelineEventPhoto } from '@shared/models/timeline-event.model';
import { SeriesMap } from '@shared/models/map.model';
import { FictionalLocationMapComponent, FictionalMapPin } from './fictional-location-map';
import { MapService } from '@app/features/maps/map.service';
import { EntityRelationshipSummary, RELATIONSHIP_TYPES } from '@shared/models/entity-relationship.model';
import { EntityService, ChapterAppearance } from '../entity.service';
import { TimelineEventService } from '../timeline-event.service';
import { EntityRelationshipService } from '../entity-relationship.service';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { VideoPlayer } from '@app/shared/video-player/video-player';
import { LazyRenderDirective } from '@app/shared/lazy-render/lazy-render';
import {
  TimelineEventDialogComponent,
  TimelineEventDialogData,
  TimelineEventDialogResult,
} from './timeline-event-dialog';
import { TimelineMapComponent } from './timeline-map';
import {
  VideoGenDialogComponent,
  VideoGenDialogData,
  VideoGenResult,
} from './video-gen-dialog';
import {
  PhotoGenDialogComponent,
  PhotoGenDialogData,
  PhotoGenResult,
} from './photo-gen-dialog';
import {
  MovePhotoDialogComponent,
  MovePhotoDialogData,
  MovePhotoDialogResult,
} from './move-photo-dialog';
import {
  ImageGenDialogComponent,
  ImageGenDialogData,
  ImageGenResult,
  ImageGenSource,
} from '../entity-edit/image-gen-dialog';

/** A frame grabbed off a video and stored, ready to be generated from. */
interface CapturedFrame {
  /** Where the frame is stored — what a generation job is pointed at. */
  url: string;
  /** Object url of the captured bytes, for the dialog's own preview. */
  previewUrl: string;
  caption: string;
}

/** How often an entity re-checks the jobs it is waiting on. */
const GENERATION_POLL_MS = 15_000;

interface BookGroup {
  bookTitle: string;
  bookId: string;
  chapters: ChapterAppearance[];
}

@Component({
  selector: 'app-entity-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    MatMenuModule,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    MatTabsModule,
    TimelineMapComponent,
    FictionalLocationMapComponent,
    VideoPlayer,
    LazyRenderDirective,
  ],
  templateUrl: './entity-detail.html',
  styleUrl: './entity-detail.scss',
})
export class EntityDetailComponent implements OnDestroy {
  entityId = input.required<string>();
  refreshTrigger = input(0);
  edit = output<void>();

  private router = inject(Router);
  private entityService = inject(EntityService);
  private timelineService = inject(TimelineEventService);
  private relationshipService = inject(EntityRelationshipService);
  private mapService = inject(MapService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private settingsService = inject(UserSettingsService);

  entity = signal<Entity | null>(null);
  loading = signal(true);
  chaptersLoading = signal(true);
  timelineEvents = signal<TimelineEvent[]>([]);
  timelineLoading = signal(true);
  relationships = signal<EntityRelationshipSummary[]>([]);
  relationshipsLoading = signal(true);

  readonly relationshipTypeLabel = (type: string) =>
    RELATIONSHIP_TYPES.find(r => r.value === type)?.label ?? type;

  // The viewed entity's role toward the partner: relationshipType describes the
  // source's role, so when this entity is the target use the inverse type.
  readonly relationshipLabel = (rel: EntityRelationshipSummary) =>
    this.relationshipTypeLabel(
      rel.direction === 'source'
        ? rel.relationshipType
        : rel.inverseRelationshipType ?? rel.relationshipType
    );
  pendingDelete = signal<TimelineEvent | null>(null);
  lightboxOpen = signal(false);
  lightboxIndex = signal(0);
  lightboxKey = signal(0);
  slideDir = signal<'next' | 'prev'>('next');
  showAllPhotos = signal(false);
  photoUploading = signal(false);
  photoGenerating = signal(false);
  photoDragOver = signal(false);
  sortingPhotos = signal(false);
  photoSortSaving = signal(false);
  sortablePhotos = signal<EntityPhoto[]>([]);
  sortMenuPos = signal({ x: 0, y: 0 });
  private sortMenuTrigger = viewChild<MatMenuTrigger>('sortMenuTrigger');
  private sortMenuPhotoIndex = -1;
  photoMenuPos = signal({ x: 0, y: 0 });
  private photoMenuTrigger = viewChild<MatMenuTrigger>('photoMenuTrigger');
  private photoMenuPhoto: EntityPhoto | null = null;
  /** Drives which items the long-press menu shows — generation is image-only. */
  photoMenuIsVideo = signal(false);
  timelineDragOverId = signal<string | null>(null);
  hoveredMapEventId = signal<string | null>(null);
  locationEntities = signal<Map<string, Entity>>(new Map());
  hoveredPlaceEntityId = signal<string | null>(null);
  loadedFictionalMaps = signal<Map<string, SeriesMap>>(new Map());

  /** One entry per unique fictional map that has at least one pin from this entity's events. */
  readonly fictionalMapTabs = computed(() => {
    const entities = this.locationEntities();
    const entityByName = new Map([...entities.values()].map(e => [e.name.toLowerCase().trim(), e]));
    const pinsByMapId = new Map<string, Map<string, FictionalMapPin>>();

    for (const ev of this.timelineEvents()) {
      let entity: Entity | undefined;
      if (ev.locationEntityId) entity = entities.get(ev.locationEntityId);
      if (!entity && ev.location?.trim()) entity = entityByName.get(ev.location.trim().toLowerCase());
      if (!entity?.location || entity.location.type !== 'fictional' || !entity.location.fictional) continue;

      const { mapId, x, y } = entity.location.fictional;
      if (!pinsByMapId.has(mapId)) pinsByMapId.set(mapId, new Map());
      const mapPins = pinsByMapId.get(mapId)!;
      if (!mapPins.has(entity.id)) mapPins.set(entity.id, { entity, x, y, eventCount: 0, events: [] });
      const pin = mapPins.get(entity.id)!;
      pin.eventCount++;
      pin.events.push(ev);
    }

    const loaded = this.loadedFictionalMaps();
    return [...pinsByMapId.entries()]
      .map(([mapId, pinsMap]) => ({ seriesMap: loaded.get(mapId), pins: [...pinsMap.values()] }))
      .filter((t): t is { seriesMap: SeriesMap; pins: FictionalMapPin[] } => !!t.seriesMap);
  });

  private timelineMapRef = viewChild(TimelineMapComponent);

  /** The lightbox's player, present only while a video is the photo on show. */
  private lightboxVideoRef = viewChild(VideoPlayer);

  /** Set while a frame is being captured and uploaded, to keep the buttons quiet. */
  capturingFrame = signal(false);

  /**
   * Whether the lightbox is offering to generate from the frame on screen. Only
   * while the video is stopped: the offer is to use *this* frame, which means
   * nothing when the frame is changing 16 times a second.
   */
  readonly canGenerateFromFrame = computed(() => this.lightboxVideoRef()?.playing() === false);

  readonly PHOTO_PREVIEW_LIMIT = 5;

  visiblePhotos = computed(() => {
    const photos = this.entity()?.photos ?? [];
    return this.settingsService.showHiddenPhotos() ? photos : photos.filter(p => !p.hidden);
  });

  /** Maps visible-photo index → actual index in entity.photos array */
  lightboxActualIndex = computed(() => {
    const idx = this.lightboxIndex();
    const allPhotos = this.entity()?.photos ?? [];
    const showHidden = this.settingsService.showHiddenPhotos();
    let vi = 0;
    for (let i = 0; i < allPhotos.length; i++) {
      if (showHidden || !allPhotos[i].hidden) {
        if (vi === idx) return i;
        vi++;
      }
    }
    return -1;
  });

  displayedPhotos = computed(() => {
    const all = this.visiblePhotos();
    return this.showAllPhotos() ? all : all.slice(0, this.PHOTO_PREVIEW_LIMIT);
  });

  chaptersByBook = computed<BookGroup[]>(() => {
    const bookMap = new Map<string, BookGroup>();
    for (const c of this._chapters()) {
      if (!bookMap.has(c.bookId)) {
        bookMap.set(c.bookId, { bookTitle: c.bookTitle, bookId: c.bookId, chapters: [] });
      }
      bookMap.get(c.bookId)!.chapters.push(c);
    }
    return [...bookMap.values()];
  });

  currentLightboxPhoto = computed(() =>
    this.visiblePhotos()[this.lightboxIndex()] ?? null
  );

  /**
   * Generation jobs for this entity that have not landed yet. The server attaches
   * finished assets on its own; this is only so the screen can say something is
   * coming and reload when it arrives.
   */
  outstandingJobs = signal<TrackedGenerationJob[]>([]);

  readonly pendingImageCount = computed(() =>
    this.outstandingJobs()
      .filter(j => j.kind === 'images')
      .reduce((n, j) => n + (j.requestedCount ?? 1), 0)
  );
  readonly pendingVideoCount = computed(
    () => this.outstandingJobs().filter(j => j.kind === 'video').length
  );

  private jobPollTimer: ReturnType<typeof setInterval> | null = null;

  private _chapters = signal<ChapterAppearance[]>([]);
  private _photosTapTimes: number[] = [];

  private _localRefresh = signal(0);

  refresh(): void {
    this._localRefresh.update(n => n + 1);
  }

  constructor() {
    effect(() => {
      const id = this.entityId();
      void this.refreshTrigger();
      void this._localRefresh();
      this.loadEntity(id);
      this.loadChapters(id);
      this.loadTimeline(id);
      this.loadRelationships(id);
      this.pollGenerationJobs(id);
    });

    // Load SeriesMap objects for any fictional PLACE entities referenced by timeline events.
    effect(() => {
      const entities = this.locationEntities();
      untracked(() => {
        const loaded = this.loadedFictionalMaps();
        const mapIds = new Set<string>();
        for (const entity of entities.values()) {
          const mapId = entity.location?.fictional?.mapId;
          if (mapId && !loaded.has(mapId)) mapIds.add(mapId);
        }
        for (const mapId of mapIds) {
          this.mapService.getById(mapId).subscribe({
            next: m => this.loadedFictionalMaps.update(cur => new Map([...cur, [m.id, m]])),
            error: () => {},
          });
        }
      });
    }, { allowSignalWrites: true });
  }

  private loadEntity(id: string): void {
    this.loading.set(true);
    this.entityService.getById(id).subscribe({
      next: (entity) => {
        this.entity.set(entity);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  private loadChapters(id: string): void {
    this.chaptersLoading.set(true);
    this.entityService.getChapterAppearances(id).subscribe({
      next: (chapters) => {
        this._chapters.set(chapters);
        this.chaptersLoading.set(false);
      },
      error: () => this.chaptersLoading.set(false),
    });
  }

  private loadRelationships(id: string): void {
    this.relationshipsLoading.set(true);
    this.relationshipService.getByEntity(id).subscribe({
      next: (rels) => {
        this.relationships.set(rels);
        this.relationshipsLoading.set(false);
      },
      error: () => this.relationshipsLoading.set(false),
    });
  }

  navigateToEntity(id: string): void {
    this.router.navigate(['/entities', id]);
  }

  private loadTimeline(id: string): void {
    this.timelineLoading.set(true);
    this.pendingDelete.set(null);
    this.timelineService.getByEntity(id).subscribe({
      next: (events) => {
        this.timelineEvents.set(events);
        this.timelineLoading.set(false);
        this.loadLocationEntities(events);
      },
      error: () => this.timelineLoading.set(false),
    });
  }

  private loadLocationEntities(events: TimelineEvent[]): void {
    const seriesId = this.entity()?.seriesId;
    if (!seriesId) {
      this.locationEntities.set(new Map());
      return;
    }
    // Load all PLACE entities for the series so we can match both by explicit ID
    // and by location string name (for events created before entity-linking was added).
    this.entityService.getBySeries(seriesId).pipe(
      map(entities => entities.filter(e => e.type === 'PLACE' && !e.archived)),
      catchError(() => of([] as Entity[])),
    ).subscribe(placeEntities => {
      const placeById = new Map(placeEntities.map(e => [e.id, e]));
      const placeByName = new Map(placeEntities.map(e => [e.name.toLowerCase().trim(), e]));

      const result = new Map<string, Entity>();
      for (const ev of events) {
        if (ev.locationEntityId) {
          const entity = placeById.get(ev.locationEntityId);
          if (entity) result.set(entity.id, entity);
        }
        if (ev.location?.trim()) {
          const matched = placeByName.get(ev.location.trim().toLowerCase());
          if (matched) result.set(matched.id, matched);
        }
      }
      this.locationEntities.set(result);
    });
  }

  addTimelineEvent(): void {
    const entity = this.entity();
    if (entity) this.openEventDialog(entity);
  }

  editTimelineEvent(event: TimelineEvent): void {
    const entity = this.entity();
    if (entity) this.openEventDialog(entity, event);
  }

  private openEventDialog(entity: Entity, event?: TimelineEvent): void {
    const ref = this.dialog.open(TimelineEventDialogComponent, {
      data: { entity, event } satisfies TimelineEventDialogData,
      autoFocus: false,
    });
    ref.afterClosed().subscribe((result?: TimelineEventDialogResult) => {
      if (!result) return;
      if (result.updatedEntity) this.entity.set(result.updatedEntity);
      if (event) {
        this.timelineService.update({
          ...event,
          name: result.name,
          timeframe: result.timeframe,
          description: result.description,
          location: result.location,
          locationEntityId: result.locationEntityId,
          photo: result.photo,
        }).subscribe({
          next: updated =>
            this.timelineEvents.update(list => list.map(e => e.id === updated.id ? updated : e)),
        });
      } else {
        this.timelineService.create({
          entityId: entity.id,
          seriesId: entity.seriesId,
          name: result.name,
          timeframe: result.timeframe,
          description: result.description,
          location: result.location,
          locationEntityId: result.locationEntityId,
          photo: result.photo,
        }).subscribe({
          next: created => this.timelineEvents.update(list => [...list, created]),
        });
      }
    });
  }

  confirmDeleteEvent(event: TimelineEvent): void {
    this.pendingDelete.set(null);
    this.timelineService.delete(event.entityId, event.id).subscribe({
      next: () => this.timelineEvents.update(list => list.filter(e => e.id !== event.id)),
    });
  }

  onTimelineDrop(drop: CdkDragDrop<TimelineEvent[]>): void {
    if (drop.previousIndex === drop.currentIndex) return;
    const events = [...this.timelineEvents()];
    moveItemInArray(events, drop.previousIndex, drop.currentIndex);
    this.applyTimelineOrder(events);
  }

  moveTimelineEvent(event: TimelineEvent, delta: number): void {
    const events = [...this.timelineEvents()];
    const from = events.findIndex(e => e.id === event.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= events.length) return;
    moveItemInArray(events, from, to);
    this.applyTimelineOrder(events);
  }

  private applyTimelineOrder(events: TimelineEvent[]): void {
    const ordered = events.map((e, i) => ({ ...e, sortOrder: i }));
    this.timelineEvents.set(ordered);
    const entityId = this.entity()?.id;
    if (entityId) this.timelineService.reorder(entityId, ordered.map(e => e.id)).subscribe();
  }

  openEventPhoto(event: TimelineEvent): void {
    if (!event.photo) return;
    const index = this.visiblePhotos().findIndex(p => p.url === event.photo!.url);
    if (index >= 0) this.openLightbox(index);
  }

  openLightbox(index: number): void {
    this.lightboxIndex.set(index);
    this.lightboxKey.update(k => k + 1);
    this.slideDir.set('next');
    this.lightboxOpen.set(true);
  }

  closeLightbox(): void {
    this.lightboxOpen.set(false);
  }

  nextPhoto(): void {
    const total = this.visiblePhotos().length;
    this.slideDir.set('next');
    this.lightboxIndex.set((this.lightboxIndex() + 1) % total);
    this.lightboxKey.update(k => k + 1);
  }

  prevPhoto(): void {
    const total = this.visiblePhotos().length;
    this.slideDir.set('prev');
    this.lightboxIndex.set((this.lightboxIndex() - 1 + total) % total);
    this.lightboxKey.update(k => k + 1);
  }

  /**
   * True when the gesture belongs to the video player rather than the lightbox:
   * the control bar always, plus the whole frame while paused (the player sets
   * data-vp-scrub then, turning the frame into a scrub surface). A swipe across
   * a *playing* video still pages the lightbox, just like a photo.
   */
  private isFromVideoPlayer(event: Event): boolean {
    return (event.target as HTMLElement | null)
      ?.closest('[data-vp-controls], [data-vp-scrub]') != null;
  }

  onLightboxKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' && this.isFromVideoPlayer(event)) return;
    if (event.key === 'ArrowRight') this.nextPhoto();
    else if (event.key === 'ArrowLeft') this.prevPhoto();
    else if (event.key === 'Escape') this.closeLightbox();
  }

  private _swipeStartX = 0;
  private _swipeStartY = 0;
  private _swipeFromVideo = false;

  onLightboxTouchStart(event: TouchEvent): void {
    const t = event.touches[0];
    if (!t) return;
    this._swipeFromVideo = this.isFromVideoPlayer(event);
    this._swipeStartX = t.clientX;
    this._swipeStartY = t.clientY;
  }

  onLightboxTouchEnd(event: TouchEvent): void {
    if (this._swipeFromVideo) return;
    if (this.visiblePhotos().length < 2) return;
    const t = event.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - this._swipeStartX;
    const dy = t.clientY - this._swipeStartY;
    // Ignore mostly-vertical gestures (scrolling)
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0) this.nextPhoto(); else this.prevPhoto();
  }

  onPhotosTitleTap(): void {
    const now = Date.now();
    this._photosTapTimes.push(now);
    if (this._photosTapTimes.length > 3) this._photosTapTimes.shift();
    if (
      this._photosTapTimes.length === 3 &&
      this._photosTapTimes[2] - this._photosTapTimes[0] < 1200
    ) {
      const next = !this.settingsService.showHiddenPhotos();
      this.settingsService.setShowHiddenPhotos(next);
      this.snackBar.open(
        next ? 'Hidden photos visible' : 'Hidden photos concealed',
        undefined,
        { duration: 2500 }
      );
      this._photosTapTimes = [];
    }
  }

  onPhotoFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    const files = picked.filter(isGalleryMediaFile);
    input.value = '';
    if (files.length) this.uploadPhotoFiles(files);
    else if (picked.length) {
      this.snackBar.open('That file type is not supported', undefined, { duration: 3000 });
    }
  }

  onPhotoDragOver(event: DragEvent): void {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.photoDragOver.set(true);
  }

  onPhotoDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (!(event.currentTarget as HTMLElement).contains(related)) {
      this.photoDragOver.set(false);
    }
  }

  onPhotosDrop(event: DragEvent): void {
    event.preventDefault();
    this.photoDragOver.set(false);
    const files = galleryMediaFrom(event.dataTransfer);
    if (files.length) this.uploadPhotoFiles(files);
  }

  onPhotoDragStart(event: DragEvent, photo: { url: string; thumbnailUrl?: string }): void {
    if (!event.dataTransfer) return;
    // Timeline event cards render their photo as an <img>, so videos aren't
    // draggable onto them — publishing no payload leaves the drop a no-op.
    if (this.isVideo(photo.url)) return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('application/quill-photo', JSON.stringify({ url: photo.url, thumbnailUrl: photo.thumbnailUrl }));
  }

  onTimelineCardDragOver(event: DragEvent, ev: TimelineEvent): void {
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (!types.includes('application/quill-photo') && !types.includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.timelineDragOverId.set(ev.id);
  }

  onTimelineCardDragLeave(event: DragEvent, ev: TimelineEvent): void {
    const related = event.relatedTarget as Node | null;
    if (!(event.currentTarget as HTMLElement).contains(related)) {
      if (this.timelineDragOverId() === ev.id) this.timelineDragOverId.set(null);
    }
  }

  onTimelineCardDrop(event: DragEvent, ev: TimelineEvent): void {
    event.preventDefault();
    this.timelineDragOverId.set(null);

    const photoData = event.dataTransfer?.getData('application/quill-photo');
    if (photoData) {
      try {
        const parsed = JSON.parse(photoData) as { url: string; thumbnailUrl?: string };
        this.assignEventPhoto(ev, { url: parsed.url, thumbnailUrl: parsed.thumbnailUrl ?? parsed.url });
        return;
      } catch {}
    }

    const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length) this.uploadEventPhoto(ev, files[0]);
  }

  private assignEventPhoto(ev: TimelineEvent, photo: TimelineEventPhoto): void {
    this.timelineService.update({ ...ev, photo }).subscribe({
      next: updated => this.timelineEvents.update(list => list.map(e => e.id === updated.id ? updated : e)),
    });
  }

  private uploadEventPhoto(ev: TimelineEvent, file: File): void {
    const entityId = this.entity()?.id;
    if (!entityId) return;
    this.entityService.uploadThumbnail(file).pipe(
      concatMap(({ url, thumbnailUrl }) =>
        this.entityService.addPhoto(entityId, url, thumbnailUrl).pipe(
          map(updatedEntity => {
            this.entity.set(updatedEntity);
            return { url, thumbnailUrl } as TimelineEventPhoto;
          })
        )
      ),
      concatMap(photo => this.timelineService.update({ ...ev, photo }))
    ).subscribe({
      next: updated => this.timelineEvents.update(list => list.map(e => e.id === updated.id ? updated : e)),
    });
  }

  openGenerateImageDialog(): void {
    const entity = this.entity();
    if (!entity) return;

    // Source options: the profile picture first, then the gallery photos.
    const sources: ImageGenSource[] = [];
    if (entity.originalUrl || entity.thumbnailUrl) {
      sources.push({
        url: entity.originalUrl ?? entity.thumbnailUrl!,
        thumbnailUrl: entity.thumbnailUrl ?? entity.originalUrl!,
        label: 'Profile',
      });
    }
    this.visiblePhotos().forEach((p, i) => {
      if (sources.some(s => s.url === p.url)) return;
      if (this.isVideo(p.url)) return; // videos can't be used as a reference image
      sources.push({ url: p.url, thumbnailUrl: p.thumbnailUrl, label: `Photo ${i + 1}` });
    });

    const ref = this.dialog.open(ImageGenDialogComponent, {
      width: '500px',
      data: {
        sources,
        defaultSourceUrl: sources[0]?.url,
      } satisfies ImageGenDialogData,
    });

    ref.afterClosed().subscribe((result?: ImageGenResult) => {
      if (!result) return;
      const entityId = this.entity()?.id;
      if (!entityId) return;
      this.photoGenerating.set(true);
      this.entityService.generateImage(result.prompt, result.referenceImageUrl).pipe(
        concatMap(({ url, thumbnailUrl }) => this.entityService.addPhoto(entityId, url, thumbnailUrl))
      ).subscribe({
        next: (updated) => {
          this.entity.set(updated);
          this.photoGenerating.set(false);
        },
        error: () => {
          this.photoGenerating.set(false);
          this.snackBar.open('Image generation failed', undefined, { duration: 3000 });
        },
      });
    });
  }

  private uploadPhotoFiles(files: File[]): void {
    const entityId = this.entity()?.id;
    if (!entityId) return;
    this.photoUploading.set(true);
    // Photos are shrunk in the browser first — see prepareImageForUpload().
    from(Promise.all(files.map(f => prepareImageForUpload(f)))).pipe(
      concatMap(prepared => forkJoin(prepared.map(f => this.entityService.uploadThumbnail(f)))),
      concatMap(results => from(results)),
      concatMap(({ url, thumbnailUrl }) => this.entityService.addPhoto(entityId, url, thumbnailUrl))
    ).subscribe({
      next: (updated) => this.entity.set(updated),
      error: (err: HttpErrorResponse) => {
        this.photoUploading.set(false);
        const reason = typeof err?.error?.error === 'string' ? err.error.error : 'Upload failed';
        this.snackBar.open(reason, undefined, { duration: 4000 });
      },
      complete: () => this.photoUploading.set(false),
    });
  }

  lightboxHide(): void {
    const entityId = this.entity()?.id;
    const actualIdx = this.lightboxActualIndex();
    if (!entityId || actualIdx < 0) return;
    this.entityService.setPhotosHidden(entityId, [actualIdx], true).subscribe({
      next: (updated) => {
        this.entity.set(updated);
        this.advanceLightboxAfterRemoval(this.lightboxIndex());
      },
    });
  }

  lightboxUnhide(): void {
    const entityId = this.entity()?.id;
    const actualIdx = this.lightboxActualIndex();
    if (!entityId || actualIdx < 0) return;
    this.entityService.setPhotosHidden(entityId, [actualIdx], false).subscribe({
      next: (updated) => this.entity.set(updated),
    });
  }

  lightboxDelete(): void {
    const entityId = this.entity()?.id;
    const actualIdx = this.lightboxActualIndex();
    if (!entityId || actualIdx < 0) return;
    this.entityService.removePhoto(entityId, actualIdx).subscribe({
      next: (updated) => {
        this.entity.set(updated);
        this.advanceLightboxAfterRemoval(this.lightboxIndex());
      },
    });
  }

  enterSortMode(): void {
    this.sortablePhotos.set([...this.visiblePhotos()]);
    this.showAllPhotos.set(true);
    this.sortingPhotos.set(true);
  }

  cancelSortMode(): void {
    this.sortingPhotos.set(false);
  }

  onSortDrop(event: CdkDragDrop<EntityPhoto[]>): void {
    const arr = [...this.sortablePhotos()];
    moveItemInArray(arr, event.previousIndex, event.currentIndex);
    this.sortablePhotos.set(arr);
  }

  saveSortOrder(): void {
    const entityId = this.entity()?.id;
    if (!entityId) return;
    const original = this.entity()!.photos ?? [];
    const sorted = this.sortablePhotos();
    const order = sorted.map(p => original.indexOf(p));
    this.photoSortSaving.set(true);
    this.entityService.reorderPhotos(entityId, order).subscribe({
      next: (updated) => {
        this.entity.set(updated);
        this.sortingPhotos.set(false);
        this.photoSortSaving.set(false);
      },
      error: () => this.photoSortSaving.set(false),
    });
  }

  private _sortPressTimer: ReturnType<typeof setTimeout> | null = null;
  private _sortPressX = 0;
  private _sortPressY = 0;

  onSortCardPointerDown(event: PointerEvent, index: number): void {
    this.cancelSortCardPress();
    this._sortPressX = event.clientX;
    this._sortPressY = event.clientY;
    this._sortPressTimer = setTimeout(
      () => this.openSortMenu(event.clientX, event.clientY, index),
      500
    );
  }

  onSortCardPointerMove(event: PointerEvent): void {
    if (this._sortPressTimer === null) return;
    // A real drag cancels the long-press; CDK drag-drop takes over.
    if (
      Math.abs(event.clientX - this._sortPressX) > 10 ||
      Math.abs(event.clientY - this._sortPressY) > 10
    ) {
      this.cancelSortCardPress();
    }
  }

  cancelSortCardPress(): void {
    if (this._sortPressTimer !== null) {
      clearTimeout(this._sortPressTimer);
      this._sortPressTimer = null;
    }
  }

  onSortCardContextMenu(event: MouseEvent, index: number): void {
    event.preventDefault();
    this.cancelSortCardPress();
    this.openSortMenu(event.clientX, event.clientY, index);
  }

  private openSortMenu(x: number, y: number, index: number): void {
    this._sortPressTimer = null;
    this.sortMenuPhotoIndex = index;
    this.sortMenuPos.set({ x, y });
    this.sortMenuTrigger()?.openMenu();
  }

  movePhotoToFront(): void {
    this.movePhotoTo(0);
  }

  movePhotoToBack(): void {
    this.movePhotoTo(this.sortablePhotos().length - 1);
  }

  private movePhotoTo(target: number): void {
    const from = this.sortMenuPhotoIndex;
    const arr = [...this.sortablePhotos()];
    if (from < 0 || from >= arr.length) return;
    moveItemInArray(arr, from, target);
    this.sortablePhotos.set(arr);
    this.sortMenuPhotoIndex = -1;
  }

  // --- "Upload" menu on a gallery photo ------------------------------------
  // Long-press on touch, right-click on a desktop; both land in openPhotoMenu().
  // Videos are left alone: the receiver only takes images.

  private _photoPressTimer: ReturnType<typeof setTimeout> | null = null;
  private _photoPressX = 0;
  private _photoPressY = 0;
  /** Set when a long-press opened the menu, so the pointerup's click is dropped. */
  private _photoPressHandled = false;

  onPhotoCardPointerDown(event: PointerEvent, photo: EntityPhoto): void {
    this.cancelPhotoCardPress();
    this._photoPressHandled = false;
    // A right-click has its own path via (contextmenu) — without this, holding
    // the right button would also trip the long-press timer and both would fire.
    if (event.button !== 0) return;
    this._photoPressX = event.clientX;
    this._photoPressY = event.clientY;
    this._photoPressTimer = setTimeout(
      () => this.openPhotoMenu(event.clientX, event.clientY, photo),
      500
    );
  }

  onPhotoCardPointerMove(event: PointerEvent): void {
    if (this._photoPressTimer === null) return;
    // Scrolling the gallery past a photo must not count as a long-press.
    if (
      Math.abs(event.clientX - this._photoPressX) > 10 ||
      Math.abs(event.clientY - this._photoPressY) > 10
    ) {
      this.cancelPhotoCardPress();
    }
  }

  cancelPhotoCardPress(): void {
    if (this._photoPressTimer !== null) {
      clearTimeout(this._photoPressTimer);
      this._photoPressTimer = null;
    }
  }

  onPhotoCardContextMenu(event: MouseEvent, photo: EntityPhoto): void {
    event.preventDefault();
    this.cancelPhotoCardPress();
    this.openPhotoMenu(event.clientX, event.clientY, photo);
  }

  /** Opens the lightbox unless a long-press already claimed this press. */
  onPhotoCardClick(index: number): void {
    this.cancelPhotoCardPress();
    // The flag is cleared on the next pointerdown, not here — a long-press that
    // never produces a click must not leave the following tap swallowed.
    if (this._photoPressHandled) return;
    this.openLightbox(index);
  }

  private openPhotoMenu(x: number, y: number, photo: EntityPhoto): void {
    this._photoPressTimer = null;
    this._photoPressHandled = true;
    this.photoMenuPhoto = photo;
    this.photoMenuIsVideo.set(this.isVideo(photo.url));
    this.photoMenuPos.set({ x, y });
    this.photoMenuTrigger()?.openMenu();
  }

  /**
   * Checks what this entity is still waiting on. The request doubles as a nudge:
   * the server collects any job that has finished while answering it, so a job
   * dropping off this list means its assets are on the entity now — hence the
   * reload. Generated media arrives hidden, so the reload only shows it when
   * hidden photos are being shown.
   */
  private pollGenerationJobs(entityId: string): void {
    this.entityService.getOutstandingJobs(entityId).subscribe({
      next: ({ jobs }) => {
        // Guard against a reply for an entity the user has already navigated away from.
        if (this.entityId() !== entityId) return;

        const landed = this.outstandingJobs().some(
          before => !jobs.some(after => after.id === before.id)
        );
        this.outstandingJobs.set(jobs);
        if (landed) this.loadEntity(entityId);
        if (jobs.length > 0) this.startJobPolling(entityId);
        else this.stopJobPolling();
      },
      // A generation job is a side errand; failing to read its state must not
      // put an error on the entity screen.
      error: () => this.stopJobPolling(),
    });
  }

  private startJobPolling(entityId: string): void {
    if (this.jobPollTimer !== null) return;
    this.jobPollTimer = setInterval(() => {
      if (this.entityId() !== entityId) {
        this.stopJobPolling();
        return;
      }
      this.pollGenerationJobs(entityId);
    }, GENERATION_POLL_MS);
  }

  private stopJobPolling(): void {
    if (this.jobPollTimer !== null) {
      clearInterval(this.jobPollTimer);
      this.jobPollTimer = null;
    }
  }

  /**
   * Moves the long-pressed photo or video onto another entity. Only the two
   * `photos` arrays change server-side — the blob stays put — so this is cheap
   * and reversible by moving it back.
   */
  moveMenuPhotoToEntity(): void {
    const photo = this.photoMenuPhoto;
    this.photoMenuPhoto = null;
    const entity = this.entity();
    if (!photo || !entity) return;

    // The index has to be into the full photos array, not the visible subset —
    // that is what the server addresses.
    const index = (entity.photos ?? []).indexOf(photo);
    if (index < 0) return;

    const data: MovePhotoDialogData = {
      thumbnailUrl: this.proxyUrl(photo.thumbnailUrl) || this.proxyUrl(photo.url) || '',
      url: photo.url,
      caption: photo.caption,
      currentEntityId: entity.id,
      currentSeriesId: entity.seriesId,
    };

    this.dialog
      .open<MovePhotoDialogComponent, MovePhotoDialogData, MovePhotoDialogResult>(
        MovePhotoDialogComponent,
        { data }
      )
      .afterClosed()
      .subscribe(result => {
        if (!result) return;
        this.movePhoto(entity.id, index, result);
      });
  }

  private movePhoto(entityId: string, index: number, result: MovePhotoDialogResult): void {
    this.entityService.movePhoto(entityId, index, result.targetEntityId).subscribe({
      next: ({ source }) => {
        this.entity.set(source);
        // The lightbox was showing the photo that just left; step it onto what
        // took its place — advanceLightboxAfterRemoval() closes it if that was
        // the last one.
        if (this.lightboxOpen()) this.advanceLightboxAfterRemoval(this.lightboxIndex());
        this.snackBar.open(`Moved to ${result.targetEntityName}`, undefined, { duration: 3000 });
      },
      error: (err: HttpErrorResponse) => {
        const reason = typeof err?.error?.error === 'string' ? err.error.error : 'Move failed';
        this.snackBar.open(reason, undefined, { duration: 4000 });
      },
    });
  }

  /**
   * Asks for a motion prompt, then queues an image-to-video job with this photo
   * as the start frame. Generation runs on the receiver, so this only reports
   * that the job was accepted — the finished clip is collected there.
   */
  generateVideoFromMenuPhoto(): void {
    const photo = this.photoMenuPhoto;
    this.photoMenuPhoto = null;
    if (!photo) return;

    const data: VideoGenDialogData = {
      thumbnailUrl: this.proxyUrl(photo.thumbnailUrl) || this.proxyUrl(photo.url) || '',
      caption: photo.caption,
    };

    this.dialog
      .open<VideoGenDialogComponent, VideoGenDialogData, VideoGenResult>(VideoGenDialogComponent, { data })
      .afterClosed()
      .subscribe(result => {
        if (!result?.prompt) return;
        this.queueVideo(photo.url, result.prompt, result.durationSeconds);
      });
  }

  /**
   * Asks for a prompt and a count, then queues a batch of stills that keep this
   * photo's face. Like video generation, this only reports that the job was
   * accepted — the finished images are collected on the receiver.
   */
  generateImagesFromMenuPhoto(): void {
    const photo = this.photoMenuPhoto;
    this.photoMenuPhoto = null;
    if (!photo) return;

    const data: PhotoGenDialogData = {
      thumbnailUrl: this.proxyUrl(photo.thumbnailUrl) || this.proxyUrl(photo.url) || '',
      caption: photo.caption,
    };

    this.dialog
      .open<PhotoGenDialogComponent, PhotoGenDialogData, PhotoGenResult>(PhotoGenDialogComponent, { data })
      .afterClosed()
      .subscribe(result => {
        if (!result?.prompt) return;
        this.queueImages(photo.url, result);
      });
  }

  // --- Generating from a frame of the video on show ------------------------
  // The gallery's own generation starts from a stored photo. A video has no one
  // photo to start from, so the user scrubs to the moment they want and that
  // frame is captured, stored, and used exactly as a gallery photo would be.

  /**
   * Asks for a motion prompt, then queues an image-to-video job whose start
   * frame is the one currently on screen in the lightbox's player.
   */
  generateVideoFromCurrentFrame(): void {
    this.withCurrentFrame(frame => {
      const data: VideoGenDialogData = {
        thumbnailUrl: frame.previewUrl,
        caption: frame.caption,
        hint: 'This frame is the first frame. Describe the motion you want.',
      };

      this.dialog
        .open<VideoGenDialogComponent, VideoGenDialogData, VideoGenResult>(VideoGenDialogComponent, { data })
        .afterClosed()
        .subscribe(result => {
          if (!this.finishWithFrame(frame, !!result?.prompt)) return;
          this.queueVideo(frame.url, result!.prompt, result!.durationSeconds);
        });
    });
  }

  /**
   * Asks for a prompt and a count, then queues a batch of stills that keep the
   * face from the frame currently on screen.
   */
  generateImagesFromCurrentFrame(): void {
    this.withCurrentFrame(frame => {
      const data: PhotoGenDialogData = {
        thumbnailUrl: frame.previewUrl,
        caption: frame.caption,
        hint: "This frame's face is kept. Describe the images you want.",
      };

      this.dialog
        .open<PhotoGenDialogComponent, PhotoGenDialogData, PhotoGenResult>(PhotoGenDialogComponent, { data })
        .afterClosed()
        .subscribe(result => {
          if (!this.finishWithFrame(frame, !!result?.prompt)) return;
          this.queueImages(frame.url, result!);
        });
    });
  }

  /**
   * Grabs the frame on show, stores it, and hands it to `run` to ask for a
   * prompt with. Storing before the dialog opens rather than on Generate is
   * what lets an abandoned dialog clean up after itself — and it means the
   * upload happens while the user is still typing.
   *
   * Capturing first also pauses the video on the chosen moment, so the preview
   * in the dialog is exactly the frame that will be sent.
   */
  private withCurrentFrame(run: (frame: CapturedFrame) => void): void {
    if (this.capturingFrame()) return;
    const player = this.lightboxVideoRef();
    if (!player) return;

    const photo = this.currentLightboxPhoto();
    const at = formatFrameTime(player.frameTime());
    const caption = photo?.caption ? `${photo.caption} — frame at ${at}` : `Frame at ${at}`;

    this.capturingFrame.set(true);
    void player.captureFrame().then(
      blob => {
        if (!blob) {
          this.capturingFrame.set(false);
          this.snackBar.open('Could not read that frame from the video', undefined, { duration: 4000 });
          return;
        }
        // Named for what it is; the stored blob gets a uuid of its own anyway.
        const file = new File([blob], 'frame.jpg', { type: 'image/jpeg' });
        this.entityService.uploadFrame(file).subscribe({
          next: ({ url }) => {
            this.capturingFrame.set(false);
            run({ url, previewUrl: URL.createObjectURL(blob), caption });
          },
          error: (err: unknown) => {
            this.capturingFrame.set(false);
            this.reportFrameUploadFailure(err);
          },
        });
      },
      () => {
        this.capturingFrame.set(false);
        this.snackBar.open('Could not read that frame from the video', undefined, { duration: 4000 });
      }
    );
  }

  /**
   * Lets go of a captured frame once its dialog has closed, and says whether
   * the job it was captured for should go ahead.
   *
   * A dialog closed without a prompt leaves a stored frame nothing will ever
   * use, so it is thrown away here. A job that goes ahead leaves its frame
   * alone: the server clears it as soon as the receiver accepts the job, and
   * until then it is what a Retry would send again.
   */
  private finishWithFrame(frame: CapturedFrame, queueing: boolean): boolean {
    URL.revokeObjectURL(frame.previewUrl);
    // Nothing to tell the user either way — a failed cleanup costs one blob.
    if (!queueing) this.entityService.discardFrame().subscribe({ error: () => undefined });
    return queueing;
  }

  private reportFrameUploadFailure(err: unknown): void {
    const reason =
      err instanceof HttpErrorResponse && typeof err.error?.error === 'string'
        ? err.error.error
        : 'the frame could not be saved';
    this.snackBar.open(`Could not use that frame: ${reason}`, 'Dismiss', { duration: 6000 });
  }

  /** Same failure handling as queueVideo() — the receiver comes and goes. */
  private queueImages(url: string, request: PhotoGenResult): void {
    const entityId = this.entity()?.id;
    this.snackBar.open('Queueing images…', undefined, { duration: 2000 });
    this.entityService.generateImagesFromPhoto(url, request, entityId).subscribe({
      next: job => {
        this.snackBar.open(
          `${request.count} image${request.count === 1 ? '' : 's'} queued${
            job.tracked ? ' — they will be added here when they finish' : ''
          }`,
          'Dismiss',
          { duration: 5000 }
        );
        if (job.tracked && entityId) this.pollGenerationJobs(entityId);
      },
      error: (err: unknown) => {
        const { reason, retryable } = this.generationFailure(err);
        const toast = this.snackBar.open(`Images failed: ${reason}`, retryable ? 'Retry' : 'Dismiss');
        if (!retryable) return;
        // Offered rather than automatic: the job is queued on the far side before
        // the reply comes back, so retrying a timeout could queue the batch twice.
        toast.onAction().subscribe(() => this.queueImages(url, request));
      },
    });
  }

  private queueVideo(url: string, prompt: string, durationSeconds: number): void {
    // The generator runs on a machine that comes and goes, so a failure here is
    // ordinary rather than exceptional: the toast stays until dismissed and
    // offers to send the same job again.
    const entityId = this.entity()?.id;
    this.snackBar.open('Queueing video…', undefined, { duration: 2000 });
    this.entityService.generateVideo(url, prompt, durationSeconds, entityId).subscribe({
      next: job => {
        this.snackBar.open(
          `${durationSeconds.toFixed(1)}s video queued${
            job.tracked ? ' — it will be added here when it finishes' : ''
          }`,
          'Dismiss',
          { duration: 5000 }
        );
        if (job.tracked && entityId) this.pollGenerationJobs(entityId);
      },
      error: (err: unknown) => {
        const { reason, retryable } = this.generationFailure(err);
        const toast = this.snackBar.open(
          `Video failed: ${reason}`,
          retryable ? 'Retry' : 'Dismiss'
        );
        if (!retryable) return;
        // Retrying is offered rather than done automatically: the job is queued
        // on the far side before the reply comes back, so an automatic retry
        // after a timeout could queue the same clip twice.
        toast.onAction().subscribe(() => this.queueVideo(url, prompt, durationSeconds));
      },
    });
  }

  /**
   * What to tell the user, and whether sending the same job again is worth
   * offering. The server names the cause in `{ error }` for everything it
   * recognises — including the receiver's own message, so a stopped ComfyUI or
   * an offline tunnel says so here rather than reading as a generic failure.
   */
  private generationFailure(err: unknown): { reason: string; retryable: boolean } {
    if (err instanceof TimeoutError) {
      return { reason: 'the request took too long and was given up on', retryable: true };
    }
    if (!(err instanceof HttpErrorResponse)) {
      return { reason: 'something went wrong sending the request', retryable: true };
    }
    // Status 0 never reached our own server — the phone lost its connection, or
    // the dev server is down. There is no body to read a reason from.
    if (err.status === 0) {
      return { reason: 'no connection to Quill — check your network', retryable: true };
    }

    const reason = typeof err.error?.error === 'string' && err.error.error.trim()
      ? err.error.error.trim()
      : `server returned ${err.status}`;

    // 4xx is this request being wrong (bad prompt, bad photo) — sending the
    // identical job again would fail the same way. 5xx is the far side or the
    // link between, which is exactly what is expected to be flaky.
    const retryable = err.status >= 500 || err.status === 429;
    return { reason, retryable };
  }

  private advanceLightboxAfterRemoval(removedIndex: number): void {
    const newCount = this.visiblePhotos().length;
    if (newCount === 0) {
      this.closeLightbox();
      return;
    }
    this.lightboxIndex.set(Math.min(removedIndex, newCount - 1));
  }

  openChapter(id: string): void {
    this.router.navigate(['/chapters', id, 'edit']);
  }

  typeLabel(type: string): string {
    return type.charAt(0) + type.slice(1).toLowerCase();
  }

  hasProfileDetails(e: Entity): boolean {
    return !!(e.title || e.firstName || e.lastName || e.gender || e.race ||
              e.orientation || e.nickname || e.preferredReference ||
              (e.type === 'PERSON' && e.personality));
  }

  preferredReferenceLabel(ref: string): string {
    const labels: Record<string, string> = {
      'full-name': 'Full Name',
      'first-name': 'First Name',
      'last-name': 'Last Name',
      'nickname': 'Nickname',
      'title-full-name': 'Title + Full Name',
      'title-last-name': 'Title + Last Name',
    };
    return labels[ref] ?? ref;
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }

  isVideo(url: string | undefined): boolean {
    return isVideoUrl(url);
  }

  /**
   * Grid poster for a video. The `#t=0.1` media fragment makes the browser seek
   * to the first frame with `preload="metadata"` instead of showing a blank box
   * (this is why the image proxy serves byte ranges).
   */
  videoPosterUrl(url: string | undefined): string | null {
    const proxied = this.proxyUrl(url);
    return proxied ? `${proxied}#t=0.1` : null;
  }

  onMapTabChange(index: number): void {
    if (index === 0) {
      this.timelineMapRef()?.onTabActivated();
    }
  }

  ngOnDestroy(): void {
    this.cancelSortCardPress();
    this.cancelPhotoCardPress();
    this.stopJobPolling();
  }
}

/** A playhead position as m:ss.t, for naming the frame a job started from. */
function formatFrameTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}
