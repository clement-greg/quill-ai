import {
  Component, ChangeDetectionStrategy, model, signal,
} from '@angular/core';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { OutlineItem } from '@shared/models/chapter.model';

@Component({
  selector: 'app-chapter-outline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DragDropModule, MatIconModule, MatButtonModule],
  templateUrl: './chapter-outline.html',
  styleUrl: './chapter-outline.scss',
})
export class ChapterOutlineComponent {
  items = model<OutlineItem[]>([]);

  readonly dragging = signal(false);

  // Phantom input at the bottom — never stored in items
  readonly phantomLevel = signal(0);

  private focusItem(id: string): void {
    setTimeout(() => {
      (document.getElementById('outline-input-' + id) as HTMLInputElement | null)?.focus();
    });
  }

  private focusPhantom(): void {
    setTimeout(() => {
      (document.getElementById('outline-phantom-input') as HTMLInputElement | null)?.focus();
    });
  }

  private addItemAfter(index: number, level: number): void {
    const id = crypto.randomUUID();
    this.items.update(list => {
      const updated = [...list];
      updated.splice(index + 1, 0, { id, text: '', level });
      return updated;
    });
    this.focusItem(id);
  }

  private removeItem(id: string): void {
    const list = this.items();
    const index = list.findIndex(i => i.id === id);
    this.items.update(l => l.filter(i => i.id !== id));
    const prev = list[index - 1];
    if (prev) {
      this.focusItem(prev.id);
    } else {
      this.focusPhantom();
    }
  }

  onDrop(event: CdkDragDrop<OutlineItem[]>): void {
    this.dragging.set(false);
    if (event.previousIndex === event.currentIndex) return;
    this.items.update(list => {
      const updated = [...list];
      moveItemInArray(updated, event.previousIndex, event.currentIndex);
      return updated;
    });
  }

  onInputChange(id: string, text: string): void {
    this.items.update(list => list.map(i => i.id === id ? { ...i, text } : i));
  }

  onKeyDown(event: KeyboardEvent, itemId: string): void {
    const list = this.items();
    const index = list.findIndex(i => i.id === itemId);
    if (index === -1) return;
    const item = list[index];

    if (event.key === 'Enter') {
      event.preventDefault();
      // If last item, move to phantom instead of inserting a new blank in the middle
      if (index === list.length - 1) {
        this.focusPhantom();
      } else {
        this.addItemAfter(index, item.level);
      }
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const newLevel = event.shiftKey ? Math.max(0, item.level - 1) : Math.min(1, item.level + 1);
      if (newLevel !== item.level) {
        this.items.update(l => l.map(i => i.id === itemId ? { ...i, level: newLevel } : i));
      }
    } else if (event.key === 'Backspace' && item.text === '') {
      event.preventDefault();
      this.removeItem(itemId);
    }
  }

  onDeleteClick(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.removeItem(id);
  }

  // Phantom handlers

  onPhantomInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const text = input.value;
    if (!text) return;

    // Promote to a real item and reset the phantom
    const id = crypto.randomUUID();
    const level = this.phantomLevel();
    input.value = '';
    this.phantomLevel.set(0);
    this.items.update(list => [...list, { id, text, level }]);
    this.focusItem(id);
  }

  onPhantomKeyDown(event: KeyboardEvent): void {
    const input = event.target as HTMLInputElement;
    if (event.key === 'Tab') {
      event.preventDefault();
      this.phantomLevel.update(l => event.shiftKey ? Math.max(0, l - 1) : Math.min(1, l + 1));
    } else if (event.key === 'ArrowUp' || (event.key === 'Backspace' && !input.value)) {
      event.preventDefault();
      const list = this.items();
      if (list.length > 0) this.focusItem(list[list.length - 1].id);
    }
  }
}
