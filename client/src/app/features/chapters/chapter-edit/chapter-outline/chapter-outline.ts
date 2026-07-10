import {
  Component, ChangeDetectionStrategy, model, signal, input,
} from '@angular/core';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { OutlineItem } from '@shared/models/chapter.model';
import { Entity } from '@shared/models/entity.model';

interface AcItem {
  entity: Entity;
  text: string;
  isPreferred: boolean;
}

@Component({
  selector: 'app-chapter-outline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DragDropModule, MatIconModule, MatButtonModule],
  templateUrl: './chapter-outline.html',
  styleUrl: './chapter-outline.scss',
})
export class ChapterOutlineComponent {
  items = model<OutlineItem[]>([]);
  entities = input<Entity[]>([]);

  readonly dragging = signal(false);
  readonly phantomLevel = signal(0);

  readonly acItems = signal<AcItem[]>([]);
  readonly acIndex = signal(0);
  readonly acTop = signal(0);
  readonly acLeft = signal(0);
  readonly acWidth = signal(200);
  readonly acAbove = signal(false);
  readonly acActiveId = signal<string | null>(null);

  private acWordStart = 0;

  private focusItem(id: string): void {
    setTimeout(() => {
      (document.getElementById('outline-input-' + id) as HTMLTextAreaElement | null)?.focus();
    });
  }

  private focusPhantom(): void {
    setTimeout(() => {
      (document.getElementById('outline-phantom-input') as HTMLTextAreaElement | null)?.focus();
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

  onInputChange(id: string, text: string, inputEl: HTMLTextAreaElement): void {
    this.items.update(list => list.map(i => i.id === id ? { ...i, text } : i));
    this.checkAutocomplete(inputEl, id);
  }

  onKeyDown(event: KeyboardEvent, itemId: string): void {
    if (this.acItems().length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.acIndex.update(i => Math.min(i + 1, this.acItems().length - 1));
        return;
      }
      if (event.key === 'ArrowUp' && this.acIndex() > 0) {
        event.preventDefault();
        this.acIndex.update(i => i - 1);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = this.acItems()[this.acIndex()];
        if (item) {
          event.preventDefault();
          this.selectAc(item.text, itemId);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.clearAc();
        return;
      }
    }

    const list = this.items();
    const index = list.findIndex(i => i.id === itemId);
    if (index === -1) return;
    const item = list[index];

    if (event.key === 'Enter') {
      event.preventDefault();
      if (index === list.length - 1) {
        this.phantomLevel.set(item.level);
        this.focusPhantom();
      } else {
        this.addItemAfter(index, item.level);
      }
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const newLevel = event.shiftKey ? Math.max(0, item.level - 1) : Math.min(2, item.level + 1);
      if (newLevel !== item.level) {
        this.items.update(l => l.map(i => i.id === itemId ? { ...i, level: newLevel } : i));
      }
    } else if (event.key === 'Backspace' && item.text === '') {
      event.preventDefault();
      this.removeItem(itemId);
    }
  }

  onInputBlur(): void {
    setTimeout(() => this.clearAc(), 150);
  }

  onDeleteClick(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.removeItem(id);
  }

  onPhantomInput(event: Event): void {
    const input = event.target as HTMLTextAreaElement;
    const text = input.value;
    if (!text) return;

    const id = crypto.randomUUID();
    const level = this.phantomLevel();
    input.value = '';
    this.phantomLevel.set(0);
    this.items.update(list => [...list, { id, text, level }]);
    this.focusItem(id);
  }

  onPhantomKeyDown(event: KeyboardEvent): void {
    const input = event.target as HTMLTextAreaElement;
    if (event.key === 'Tab') {
      event.preventDefault();
      this.phantomLevel.update(l => event.shiftKey ? Math.max(0, l - 1) : Math.min(2, l + 1));
    } else if (event.key === 'ArrowUp' || (event.key === 'Backspace' && !input.value)) {
      event.preventDefault();
      const list = this.items();
      if (list.length > 0) this.focusItem(list[list.length - 1].id);
    }
  }

  selectAc(text: string, itemId: string): void {
    const inputEl = document.getElementById('outline-input-' + itemId) as HTMLTextAreaElement | null;
    if (!inputEl) { this.clearAc(); return; }

    const cursorPos = inputEl.selectionStart ?? inputEl.value.length;
    const newValue = inputEl.value.substring(0, this.acWordStart) + text + inputEl.value.substring(cursorPos);
    const newCursor = this.acWordStart + text.length;

    inputEl.value = newValue;
    this.items.update(list => list.map(i => i.id === itemId ? { ...i, text: newValue } : i));
    this.clearAc();

    setTimeout(() => {
      inputEl.focus();
      inputEl.setSelectionRange(newCursor, newCursor);
    });
  }

  clearAc(): void {
    if (this.acItems().length === 0) return;
    this.acItems.set([]);
    this.acActiveId.set(null);
    this.acWordStart = 0;
  }

  private checkAutocomplete(inputEl: HTMLTextAreaElement, itemId: string): void {
    const wordInfo = this.getWordAtCursor(inputEl);
    if (!wordInfo) { this.clearAc(); return; }

    const lower = wordInfo.word.toLowerCase();
    const flat: AcItem[] = [];

    for (const entity of this.entities()) {
      if (entity.archived || entity.deleted) continue;
      if (!this.entityMatchesWord(entity, lower)) continue;
      const preferred = this.getPreferredText(entity);
      const seen = new Set<string>([preferred]);
      flat.push({ entity, text: preferred, isPreferred: true });
      for (const ref of this.allRefsFor(entity)) {
        if (!seen.has(ref)) { seen.add(ref); flat.push({ entity, text: ref, isPreferred: false }); }
      }
    }

    if (flat.length === 0) { this.clearAc(); return; }

    this.acActiveId.set(itemId);
    this.acWordStart = wordInfo.start;
    this.acIndex.set(0);
    this.acItems.set(flat);

    const rect = inputEl.getBoundingClientRect();
    const DROPDOWN_HEIGHT = 200;
    const GAP = 2;
    const above = rect.bottom + GAP + DROPDOWN_HEIGHT > window.innerHeight;
    this.acAbove.set(above);
    this.acTop.set(above ? rect.top - GAP : rect.bottom + GAP);
    this.acLeft.set(rect.left);
    this.acWidth.set(Math.max(rect.width, 180));
  }

  private getWordAtCursor(input: HTMLTextAreaElement): { word: string; start: number } | null {
    const text = input.value;
    const pos = input.selectionStart ?? text.length;
    let start = pos;
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    const word = text.substring(start, pos);
    if (!word || word.length < 2) return null;
    return { word, start };
  }

  private entityMatchesWord(entity: Entity, lower: string): boolean {
    return this.allRefsFor(entity).some(v => v.toLowerCase().includes(lower));
  }

  private allRefsFor(entity: Entity): string[] {
    const refs: string[] = [entity.name];
    if (entity.firstName) refs.push(entity.firstName);
    if (entity.lastName) refs.push(entity.lastName);
    if (entity.nickname) refs.push(entity.nickname);
    if (entity.firstName && entity.lastName) refs.push(`${entity.firstName} ${entity.lastName}`);
    if (entity.title && entity.name) refs.push(`${entity.title} ${entity.name}`);
    if (entity.title && entity.lastName) refs.push(`${entity.title} ${entity.lastName}`);
    return refs.filter(Boolean);
  }

  private getPreferredText(entity: Entity): string {
    switch (entity.preferredReference) {
      case 'first-name': return entity.firstName || entity.name;
      case 'last-name': return entity.lastName || entity.name;
      case 'nickname': return entity.nickname || entity.name;
      case 'title-full-name': return entity.title ? `${entity.title} ${entity.name}` : entity.name;
      case 'title-last-name': return entity.title && entity.lastName ? `${entity.title} ${entity.lastName}` : entity.name;
      default: return entity.name;
    }
  }
}
