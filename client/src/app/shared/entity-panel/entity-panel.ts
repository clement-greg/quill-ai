import { Component, inject, signal } from '@angular/core';
import { forkJoin, from } from 'rxjs';
import { concatMap, switchMap } from 'rxjs/operators';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { EntityPanelService } from '../../services/entity-panel.service';
import { EntityService } from '../../services/entity.service';
import { EntityEditComponent } from '../../entity-edit/entity-edit';

@Component({
  selector: 'app-entity-panel',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    EntityEditComponent,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
  ],
  templateUrl: './entity-panel.html',
  styleUrl: './entity-panel.scss',
})
export class EntityPanelComponent {
  panel = inject(EntityPanelService);
  private entityService = inject(EntityService);

  uploadingEntityId = signal<string | null>(null);
  dragOverEntityId = signal<string | null>(null);

  onListDragOver(event: DragEvent): void {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-entity-id]');
    const id = item?.dataset['entityId'] ?? null;
    if (id !== this.dragOverEntityId()) {
      this.dragOverEntityId.set(id);
    }
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
    this.uploadingEntityId.set(entityId);
    // Upload all thumbnails in parallel, then add each photo to the entity sequentially
    forkJoin(files.map(f => this.entityService.uploadThumbnail(f))).pipe(
      switchMap(results =>
        from(results).pipe(
          concatMap(({ url, thumbnailUrl }) => this.entityService.addPhoto(entityId, url, thumbnailUrl))
        )
      )
    ).subscribe({
      next: (updated) => {
        this.panel.entityList.update(list => list.map(e => e.id === entityId ? updated : e));
        if (this.panel.editingEntity()?.id === entityId) {
          this.panel.editingEntity.set({ ...updated });
        }
        if (this.panel.narrator()?.id === entityId) {
          this.panel.narrator.set(updated);
        }
      },
      error: () => this.uploadingEntityId.set(null),
      complete: () => this.uploadingEntityId.set(null),
    });
  }
  onGroupDrop(type: string, event: CdkDragDrop<unknown>): void {    this.panel.reorderWithinGroup(type, event.previousIndex, event.currentIndex);
  }

  groupLabel(type: string): string {
    return type.charAt(0) + type.slice(1).toLowerCase() + 's';
  }

  groupIcon(type: string): string {
    return type === 'PERSON' ? 'people' : type === 'PLACE' ? 'place' : 'category';
  }
}
