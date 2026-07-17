import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { diffWords } from 'diff';

interface DiffWord { type: 'same' | 'add' | 'remove'; text: string; }
interface DiffParagraph { hasChanges: boolean; segments: DiffWord[]; }

/** Renders a word-level diff between two HTML strings, with a legend
 *  labeling each side. Shared by the version history panel and the
 *  unsaved-draft comparison. */
@Component({
  selector: 'app-text-diff-view',
  template: `
    <div class="diff-legend">
      <span class="legend-remove">&#8722; {{ oldLabel() }}</span>
      <span class="legend-add">&#43; {{ newLabel() }}</span>
    </div>
    <div class="diff-content">
      @for (para of paragraphs(); track $index) {
        <p class="diff-paragraph" [class.diff-paragraph-changed]="para.hasChanges">
          @for (seg of para.segments; track $index) {
            <span [class.diff-word-add]="seg.type === 'add'" [class.diff-word-remove]="seg.type === 'remove'">{{ seg.text }}</span>
          }
        </p>
      }
    </div>
  `,
  styleUrl: './text-diff-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TextDiffViewComponent {
  oldText = input('');
  newText = input('');
  oldLabel = input('Previous');
  newLabel = input('Current');

  paragraphs = computed(() => computeDiff(stripHtml(this.oldText()), stripHtml(this.newText())));
}

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.innerText || div.textContent || '').trim();
}

function computeDiff(oldText: string, newText: string): DiffParagraph[] {
  const changes = diffWords(oldText, newText);
  const paragraphs: DiffParagraph[] = [{ hasChanges: false, segments: [] }];
  for (const change of changes) {
    const type: 'same' | 'add' | 'remove' = change.added ? 'add' : change.removed ? 'remove' : 'same';
    const parts = change.value.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) paragraphs.push({ hasChanges: false, segments: [] });
      if (parts[i]) {
        const para = paragraphs[paragraphs.length - 1];
        para.segments.push({ type, text: parts[i] });
        if (type !== 'same') para.hasChanges = true;
      }
    }
  }
  return paragraphs.filter(p => p.segments.length > 0);
}
