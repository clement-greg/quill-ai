import {
  Component,
  inject,
  signal,
  computed,
  effect,
  afterEveryRender,
  ChangeDetectionStrategy,
  ElementRef,
  OnInit,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';
import { forkJoin, from } from 'rxjs';
import { concatMap, switchMap } from 'rxjs/operators';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { v4 as uuidv4 } from 'uuid';
import { Entity } from '@shared/models/entity.model';
import { EntityPanelService } from '../services/entity-panel.service';
import { EntityService } from '../services/entity.service';
import { SeriesContextService } from '../services/series-context.service';
import { HeaderService } from '../services/header.service';
import { EntityDetailComponent } from '../entity-detail/entity-detail';
import { EntityEditComponent } from '../entity-edit/entity-edit';
import { EntityCollageComponent } from './entity-collage';

@Component({
  selector: 'app-entity-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    CdkDrag,
    CdkDragHandle,
    CdkDropList,
    EntityDetailComponent,
    EntityEditComponent,
    EntityCollageComponent,
  ],
  templateUrl: './entity-page.html',
  styleUrl: './entity-page.scss',
})
export class EntityPageComponent implements OnInit, OnDestroy {
  protected panel = inject(EntityPanelService);
  private entityService = inject(EntityService);
  private seriesContext = inject(SeriesContextService);
  private headerService = inject(HeaderService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  @ViewChild('entityListPanel') private entityListPanelRef?: ElementRef<HTMLElement>;
  private lastScrolledEntityId = '';

  selectedEntityId = toSignal(
    this.route.paramMap.pipe(map(p => p.get('id')))
  );

  showPanel = signal(false);
  isCollapsed = computed(() => !!this.selectedEntityId());
  // Browsing = nothing selected and not editing; on mobile the content panel
  // is hidden in this state so the entity list gets the full viewport.
  isBrowsing = computed(() =>
    !this.selectedEntityId() && !(this.isEditMode() && this.editingEntity())
  );
  isEditMode = signal(false);
  editingEntity = signal<Entity | null>(null);
  isNewEntity = signal(false);
  uploadingEntityId = signal<string | null>(null);
  dragOverEntityId = signal<string | null>(null);
  detailRefreshTrigger = signal(0);

  mentionCounts = signal<Record<string, number>>({});
  private mentionCountsSeriesId: string | null = null;

  collageEntities = computed(() => {
    const narrator = this.panel.narrator();
    const list = this.panel.entityList();
    return narrator ? [narrator, ...list] : list;
  });

  constructor() {
    effect(() => {
      const seriesId = this.panel.seriesId();
      if (!seriesId || seriesId === this.mentionCountsSeriesId) return;
      this.mentionCountsSeriesId = seriesId;
      this.entityService.getMentionCounts(seriesId).subscribe({
        next: ({ counts }) => this.mentionCounts.set(counts),
        error: () => this.mentionCounts.set({}),
      });
    });

    afterEveryRender(() => {
      const id = this.selectedEntityId() ?? '';
      if (!id || id === this.lastScrolledEntityId) return;
      const panel = this.entityListPanelRef?.nativeElement;
      const selected = panel?.querySelector<HTMLElement>('.avatar-btn--selected');
      if (!panel || !selected) return;
      this.lastScrolledEntityId = id;
      const panelRect = panel.getBoundingClientRect();
      const btnRect = selected.getBoundingClientRect();
      const targetLeft = panel.scrollLeft + btnRect.left - panelRect.left - panel.clientWidth / 2 + btnRect.width / 2;
      panel.scrollTo({ left: targetLeft, behavior: 'smooth' });
    });
  }

  ngOnInit(): void {
    this.headerService.setPage('Entities');
    const seriesId = this.seriesContext.currentSeriesId();
    if (seriesId) {
      this.panel.loadAllSeries(seriesId);
    } else {
      // If arriving directly at /entities/:id with no series context, load the
      // entity first so we can derive its seriesId and seed the left panel.
      const entityId = this.route.snapshot.paramMap.get('id');
      if (entityId) {
        this.entityService.getById(entityId).subscribe({
          next: (entity) => this.panel.loadAllSeries(entity.seriesId),
          error: () => this.panel.loadAllSeries(null),
        });
      } else {
        this.panel.loadAllSeries(null);
      }
    }
  }

  ngOnDestroy(): void {
    this.headerService.clear();
  }

  selectEntity(entityId: string): void {
    if (this.selectedEntityId() === entityId) {
      this.router.navigate(['/entities']);
    } else {
      this.router.navigate(['/entities', entityId]);
    }
  }

  addEntity(): void {
    const seriesId = this.panel.seriesId();
    if (!seriesId) return;
    const entity: Entity = { id: uuidv4(), name: '', type: 'PERSON', seriesId };
    this.isNewEntity.set(true);
    this.editingEntity.set(entity);
    this.isEditMode.set(true);
    // Navigate to /entities (no selection) so full list shows while creating
    this.router.navigate(['/entities']);
  }

  onEditRequested(): void {
    const id = this.selectedEntityId();
    if (!id) return;
    const fromList =
      this.panel.entityList().find(e => e.id === id) ??
      (this.panel.narrator()?.id === id ? this.panel.narrator() : null);
    if (fromList) {
      this.isNewEntity.set(false);
      this.editingEntity.set({ ...fromList });
      this.isEditMode.set(true);
    } else {
      this.entityService.getById(id).subscribe(entity => {
        this.isNewEntity.set(false);
        this.editingEntity.set({ ...entity });
        this.isEditMode.set(true);
      });
    }
  }

  onSave(entity: Entity): void {
    if (this.isNewEntity()) {
      this.entityService.create(entity).subscribe({
        next: (created) => {
          this.panel.entityList.update(list => [...list, created]);
          this.isNewEntity.set(false);
          this.isEditMode.set(false);
          this.editingEntity.set(null);
          this.router.navigate(['/entities', created.id]);
        },
      });
    } else {
      this.entityService.update(entity).subscribe({
        next: (updated) => {
          if (updated.isNarrator) {
            this.panel.narrator.set(updated);
          } else {
            this.panel.entityList.update(list =>
              list.map(e => e.id === updated.id ? updated : e)
            );
          }
          this.isEditMode.set(false);
          this.editingEntity.set(null);
          this.detailRefreshTrigger.update(n => n + 1);
        },
      });
    }
  }

  onCancel(): void {
    this.isEditMode.set(false);
    this.editingEntity.set(null);
    this.isNewEntity.set(false);
  }

  onViewDetails(): void {
    this.isEditMode.set(false);
    this.editingEntity.set(null);
    this.isNewEntity.set(false);
  }

  onArchive(id: string): void {
    this.entityService.archive(id).subscribe({
      next: () => {
        this.panel.entityList.update(list => list.filter(e => e.id !== id));
        this.isEditMode.set(false);
        this.editingEntity.set(null);
        this.isNewEntity.set(false);
        this.router.navigate(['/entities']);
      },
    });
  }

  onUnarchive(id: string): void {
    this.entityService.unarchive(id).subscribe({
      next: () => {
        this.panel.entityList.update(list => list.filter(e => e.id !== id));
        this.isEditMode.set(false);
        this.editingEntity.set(null);
        this.isNewEntity.set(false);
        this.router.navigate(['/entities']);
      },
    });
  }

  onRefresh(): void {
    const entity = this.editingEntity();
    if (!entity?.id) return;
    this.entityService.getById(entity.id).subscribe({
      next: (fresh) => {
        this.editingEntity.set({ ...fresh });
        if (fresh.isNarrator) {
          this.panel.narrator.set(fresh);
        } else {
          this.panel.entityList.update(list =>
            list.map(e => e.id === fresh.id ? fresh : e)
          );
        }
      },
    });
  }

  onGroupDrop(type: string, event: CdkDragDrop<unknown>): void {
    this.panel.reorderWithinGroup(type, event.previousIndex, event.currentIndex);
  }

  onListDragOver(event: DragEvent): void {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-entity-id]');
    const id = item?.dataset['entityId'] ?? null;
    if (id !== this.dragOverEntityId()) this.dragOverEntityId.set(id);
  }

  onListDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (!(event.currentTarget as HTMLElement).contains(related)) {
      this.dragOverEntityId.set(null);
    }
  }

  onListDrop(event: DragEvent): void {
    event.preventDefault();
    const entityId = this.dragOverEntityId();
    this.dragOverEntityId.set(null);
    if (!entityId) return;
    const files = Array.from(event.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    this.uploadFilesToEntity(entityId, files);
  }

  onCollageDrop(event: { entityId: string; files: File[] }): void {
    this.uploadFilesToEntity(event.entityId, event.files);
  }

  private uploadFilesToEntity(entityId: string, files: File[]): void {
    this.uploadingEntityId.set(entityId);
    forkJoin(files.map(f => this.entityService.uploadThumbnail(f))).pipe(
      switchMap(results =>
        from(results).pipe(
          concatMap(({ url, thumbnailUrl }) =>
            this.entityService.addPhoto(entityId, url, thumbnailUrl, true)
          )
        )
      )
    ).subscribe({
      next: (updated) => {
        this.panel.entityList.update(list => list.map(e => e.id === entityId ? updated : e));
        if (this.panel.narrator()?.id === entityId) this.panel.narrator.set(updated);
      },
      error: () => this.uploadingEntityId.set(null),
      complete: () => this.uploadingEntityId.set(null),
    });
  }

  togglePanel(): void {
    this.showPanel.update(v => !v);
  }

  groupLabel(type: string): string {
    return type.charAt(0) + type.slice(1).toLowerCase() + 's';
  }

  groupIcon(type: string): string {
    return type === 'PERSON' ? 'people' : type === 'PLACE' ? 'place' : 'category';
  }
}
