import { Injectable, computed, inject, signal } from '@angular/core';
import { EntityService } from './entity.service';
import { SeriesService } from '../series/series.service';
import { Entity } from '@shared/models/entity.model';
import { Series } from '@shared/models/series.model';
import { v4 as uuidv4 } from 'uuid';

@Injectable({ providedIn: 'root' })
export class EntityPanelService {
  private entityService = inject(EntityService);
  private seriesService = inject(SeriesService);

  isOpen = signal(false);
  allSeries = signal<Series[]>([]);
  seriesId = signal<string | null>(null);
  narrator = signal<Entity | null>(null);
  entityList = signal<Entity[]>([]);
  editingEntity = signal<Entity | null>(null);
  isNewEntity = signal(false);
  entityLoading = signal(false);
  showingArchived = signal(false);
  lastUpdatedEntity = signal<Entity | null>(null);
  private readonly COLLAPSED_KEY = 'entityPanel.collapsedGroups';
  collapsedGroups = signal<Set<string>>(this.loadCollapsedGroups());

  private loadCollapsedGroups(): Set<string> {
    try {
      const stored = localStorage.getItem(this.COLLAPSED_KEY);
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch {
      return new Set();
    }
  }

  private saveCollapsedGroups(set: Set<string>): void {
    try {
      localStorage.setItem(this.COLLAPSED_KEY, JSON.stringify([...set]));
    } catch { /* storage unavailable */ }
  }

  readonly GROUP_ORDER = ['PERSON', 'PLACE', 'THING'] as const;

  entityGroups = computed(() => {
    const list = this.entityList();
    return this.GROUP_ORDER
      .map(type => ({ type, entities: list.filter(e => e.type === type) }))
      .filter(g => g.entities.length > 0);
  });

  get panelWidth(): number {
    return this.editingEntity() ? 572 : 340;
  }

  openPanel(seriesId?: string | null): void {
    this.isOpen.set(true);
    if (this.allSeries().length === 0) {
      this.loadAllSeries(seriesId ?? null);
    } else if (seriesId) {
      this.selectSeries(seriesId);
    }
  }

  open(seriesId: string): void {
    this.seriesId.set(seriesId);
    this.editingEntity.set(null);
    this.isNewEntity.set(false);
    this.showingArchived.set(false);
    this.isOpen.set(true);
    if (this.allSeries().length === 0) {
      this.loadAllSeries(seriesId);
    } else {
      this.loadEntities(seriesId);
      this.loadNarrator(seriesId);
    }
  }

  loadAllSeries(autoSelectId: string | null = null): void {
    this.seriesService.getAll().subscribe({
      next: (data) => {
        const active = data
          .filter((s: any) => !s.deleted && !s.archived)
          .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
        this.allSeries.set(active);
        const targetId = autoSelectId ?? (active.length === 1 ? active[0].id : null);
        if (targetId) {
          this.selectSeries(targetId);
        }
      },
    });
  }

  selectSeries(id: string): void {
    if (this.seriesId() === id) return;
    this.seriesId.set(id);
    this.editingEntity.set(null);
    this.isNewEntity.set(false);
    this.showingArchived.set(false);
    this.loadEntities(id);
    this.loadNarrator(id);
  }

  close(): void {
    this.isOpen.set(false);
    this.editingEntity.set(null);
    this.isNewEntity.set(false);
  }

  loadNarrator(seriesId: string): void {
    this.entityService.getOrCreateNarrator(seriesId).subscribe({
      next: (narrator) => this.narrator.set(narrator),
      error: () => {},
    });
  }

  loadEntities(seriesId: string): void {
    this.entityLoading.set(true);
    const fetch = this.showingArchived()
      ? this.entityService.getArchivedBySeries(seriesId)
      : this.entityService.getBySeries(seriesId);
    fetch.subscribe({
      next: (data) => {
        // Keep narrator out of the main list (it has its own dedicated section)
        const filtered = data.filter(e => !e.isNarrator);
        filtered.sort((a, b) => {
          const aOrder = a.sortOrder ?? Infinity;
          const bOrder = b.sortOrder ?? Infinity;
          return aOrder - bOrder;
        });
        this.entityList.set(filtered);
        this.entityLoading.set(false);
      },
      error: () => this.entityLoading.set(false),
    });
  }

  toggleArchived(): void {
    const seriesId = this.seriesId();
    if (!seriesId) return;
    this.editingEntity.set(null);
    this.isNewEntity.set(false);
    this.showingArchived.update(v => !v);
    this.loadEntities(seriesId);
  }

  addEntity(): void {
    const id = this.seriesId();
    if (!id) return;
    const entity: Entity = { id: uuidv4(), name: '', type: 'PERSON', seriesId: id };
    this.isNewEntity.set(true);
    this.editingEntity.set(entity);
  }

  startEditEntity(entity: Entity): void {
    if (this.editingEntity()?.id === entity.id) {
      this.editingEntity.set(null);
      this.isNewEntity.set(false);
      return;
    }
    this.isNewEntity.set(false);
    this.editingEntity.set({ ...entity });
  }

  cancelEditEntity(): void {
    this.editingEntity.set(null);
    this.isNewEntity.set(false);
  }

  saveEntityEdit(entity: Entity): void {
    if (this.isNewEntity()) {
      this.entityService.create(entity).subscribe({
        next: (created) => {
          this.entityList.update((list) => [...list, created]);
          this.isNewEntity.set(false);
          this.editingEntity.set(created);
          this.lastUpdatedEntity.set(created);
        },
      });
    } else {
      this.entityService.update(entity).subscribe({
        next: (updated) => {
          if (updated.isNarrator) {
            this.narrator.set(updated);
          } else {
            this.entityList.update((list) =>
              list.map((e) => (e.id === updated.id ? updated : e))
            );
          }
          this.editingEntity.set(null);
          this.lastUpdatedEntity.set(updated);
        },
      });
    }
  }

  deleteEntity(id: string): void {
    this.entityService.delete(id).subscribe({
      next: () => {
        this.entityList.update((list) => list.filter((e) => e.id !== id));
        if (this.editingEntity()?.id === id) {
          this.editingEntity.set(null);
        }
      },
    });
  }

  archiveEntity(id: string): void {
    this.entityService.archive(id).subscribe({
      next: () => {
        this.entityList.update((list) => list.filter((e) => e.id !== id));
        if (this.editingEntity()?.id === id) {
          this.editingEntity.set(null);
        }
      },
    });
  }

  unarchiveEntity(id: string): void {
    this.entityService.unarchive(id).subscribe({
      next: () => {
        this.entityList.update((list) => list.filter((e) => e.id !== id));
        if (this.editingEntity()?.id === id) {
          this.editingEntity.set(null);
        }
      },
    });
  }

  toggleGroup(type: string): void {
    this.collapsedGroups.update(set => {
      const next = new Set(set);
      if (next.has(type)) next.delete(type); else next.add(type);
      this.saveCollapsedGroups(next);
      return next;
    });
  }

  isGroupCollapsed(type: string): boolean {
    return this.collapsedGroups().has(type);
  }

  reorderWithinGroup(type: string, previousIndex: number, currentIndex: number): void {
    const list = [...this.entityList()];
    // Extract only this group's items in order
    const groupItems = list.filter(e => e.type === type);
    const [moved] = groupItems.splice(previousIndex, 1);
    groupItems.splice(currentIndex, 0, moved);
    // Rebuild the full list, replacing type items with reordered ones
    let gi = 0;
    const result = list.map(e => e.type === type ? groupItems[gi++] : e);
    this.entityList.set(result);
    this.entityService.reorder(result.map(e => e.id)).subscribe();
  }

  proxyUrl(url: string | undefined): string | null {
    if (!url) return null;
    const filename = url.split('/').pop();
    return filename ? `/api/image/${filename}` : null;
  }
}
