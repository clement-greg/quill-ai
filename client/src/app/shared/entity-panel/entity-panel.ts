import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList } from '@angular/cdk/drag-drop';
import { EntityPanelService } from '../../services/entity-panel.service';
import { EntityEditComponent } from '../../entity-edit/entity-edit';

@Component({
  selector: 'app-entity-panel',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatTooltipModule,
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

  onGroupDrop(type: string, event: CdkDragDrop<unknown>): void {
    this.panel.reorderWithinGroup(type, event.previousIndex, event.currentIndex);
  }

  groupLabel(type: string): string {
    return type.charAt(0) + type.slice(1).toLowerCase() + 's';
  }

  groupIcon(type: string): string {
    return type === 'PERSON' ? 'people' : type === 'PLACE' ? 'place' : 'category';
  }
}
