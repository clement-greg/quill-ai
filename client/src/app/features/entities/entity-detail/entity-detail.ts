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
import { forkJoin, from, of } from 'rxjs';
import { concatMap, map, catchError } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { CdkDropList, CdkDrag, CdkDragHandle, CdkDragDrop, CdkDragPlaceholder, moveItemInArray } from '@angular/cdk/drag-drop';
import { Entity, EntityPhoto } from '@shared/models/entity.model';
import { TimelineEvent, TimelineEventPhoto } from '@shared/models/timeline-event.model';
import { SeriesMap } from '@shared/models/map.model';
import { FictionalLocationMapComponent, FictionalMapPin } from './fictional-location-map';
import { MapService } from '@app/features/maps/map.service';
import { EntityRelationshipSummary, RELATIONSHIP_TYPES } from '@shared/models/entity-relationship.model';
import { EntityService, ChapterAppearance } from '../entity.service';
import { TimelineEventService } from '../timeline-event.service';
import { EntityRelationshipService } from '../entity-relationship.service';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import {
  TimelineEventDialogComponent,
  TimelineEventDialogData,
  TimelineEventDialogResult,
} from './timeline-event-dialog';
import { TimelineMapComponent } from './timeline-map';
import {
  ImageGenDialogComponent,
  ImageGenDialogData,
  ImageGenResult,
  ImageGenSource,
} from '../entity-edit/image-gen-dialog';

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

  onLightboxKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowRight') this.nextPhoto();
    else if (event.key === 'ArrowLeft') this.prevPhoto();
    else if (event.key === 'Escape') this.closeLightbox();
  }

  private _swipeStartX = 0;
  private _swipeStartY = 0;

  onLightboxTouchStart(event: TouchEvent): void {
    const t = event.touches[0];
    if (!t) return;
    this._swipeStartX = t.clientX;
    this._swipeStartY = t.clientY;
  }

  onLightboxTouchEnd(event: TouchEvent): void {
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
    const files = Array.from(input.files ?? []).filter(f => f.type.startsWith('image/'));
    input.value = '';
    if (files.length) this.uploadPhotoFiles(files);
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
    const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length) this.uploadPhotoFiles(files);
  }

  onPhotoDragStart(event: DragEvent, photo: { url: string; thumbnailUrl?: string }): void {
    if (!event.dataTransfer) return;
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
    forkJoin(files.map(f => this.entityService.uploadThumbnail(f))).pipe(
      concatMap(results => from(results)),
      concatMap(({ url, thumbnailUrl }) => this.entityService.addPhoto(entityId, url, thumbnailUrl))
    ).subscribe({
      next: (updated) => this.entity.set(updated),
      error: () => this.photoUploading.set(false),
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

  onMapTabChange(index: number): void {
    if (index === 0) {
      this.timelineMapRef()?.onTabActivated();
    }
  }

  ngOnDestroy(): void {}
}
