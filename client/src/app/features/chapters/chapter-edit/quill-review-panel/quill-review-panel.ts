import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, output,
  signal, untracked, CUSTOM_ELEMENTS_SCHEMA,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { EditorReviewService, ReviewSuggestion } from '../../editor-review.service';
import { RichTextEditorComponent } from '@app/shared/rich-text-editor/rich-text-editor';

/** Sidebar tab that lists the streamed AI editorial-pass suggestions and lets
 *  the author accept, reject, edit, or refine each one. The parent supplies
 *  the editor instance so accepted edits can be applied to the document. */
@Component({
  selector: 'app-quill-review-panel',
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './quill-review-panel.html',
  styleUrl: './quill-review-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class QuillReviewPanelComponent {
  chapterId = input<string | null>(null);
  editor = input<RichTextEditorComponent | null>(null);
  /** Suggestion id currently hovered in the document (doc→sidebar highlight). */
  hoveredId = input<string | null>(null);
  /** The author clicked "Run Quill Editor" — the parent starts the pass. */
  runReview = output<void>();

  private snackBar = inject(MatSnackBar);
  readonly editorReview = inject(EditorReviewService);

  /** When false, low-severity suggestions are hidden (the default). */
  quillShowLow = signal(false);
  /** Suggestions filtered by the current severity toggle. */
  quillSuggestions = computed(() => this.editorReview.visible(this.quillShowLow()));
  quillOpenCount = computed(() =>
    this.quillSuggestions().filter(s => s.status === 'open').length,
  );
  /** Ids of suggestions currently decorated in the document. */
  private decoratedReviewIds = new Set<string>();
  /** Suggestion whose free-form refine box is open. */
  quillRefineOpenId = signal<string | null>(null);
  /** Suggestion currently being refined (shows a spinner). */
  quillRefiningId = signal<string | null>(null);
  quillRefineText = signal('');
  /** Suggestion whose replacement text is being manually edited before accept. */
  quillEditOpenId = signal<string | null>(null);
  quillEditText = signal('');

  constructor() {
    // Keep the document's inline review decorations in sync with the streamed,
    // severity-filtered, still-open suggestions.
    effect(() => {
      this.quillSuggestions(); // track changes (stream, filter toggle, accept/reject)
      this.editor(); // re-reconcile once the editor instance arrives
      untracked(() => this.reconcileReviewDecorations());
    });
  }

  /** Forgets which suggestions are decorated (e.g. before a fresh review run). */
  resetDecorations(): void {
    this.decoratedReviewIds.clear();
  }

  acceptQuillSuggestion(s: ReviewSuggestion): void {
    // Comments are informational — acknowledging one just resolves it (no edit).
    if (s.type === 'comment') {
      this.editor()?.undecorateSuggestion(s.id);
      this.editorReview.markAccepted(s.id);
      this.maybeUnlockEditor();
      return;
    }
    const applied = this.editor()?.acceptSuggestionEdit(s);
    if (applied) {
      this.editorReview.markAccepted(s.id);
    } else {
      this.editorReview.markRejected(s.id);
      this.snackBar.open("Couldn't locate that text — it may have changed.", 'OK', { duration: 3000 });
    }
    this.maybeUnlockEditor();
  }

  rejectQuillSuggestion(s: ReviewSuggestion): void {
    this.editorReview.markRejected(s.id);
    this.maybeUnlockEditor();
  }

  /** Applies every still-open visible text edit. Comments are left for the
   *  author to read and dismiss individually (there's nothing to apply). */
  acceptAllQuillSuggestions(): void {
    for (const s of this.quillSuggestions()) {
      if (s.status !== 'open' || s.type === 'comment') continue;
      const applied = this.editor()?.acceptSuggestionEdit(s);
      if (applied) this.editorReview.markAccepted(s.id);
      else this.editorReview.markRejected(s.id);
    }
    this.maybeUnlockEditor();
  }

  rejectAllQuillSuggestions(): void {
    for (const s of this.quillSuggestions()) {
      if (s.status === 'open') this.editorReview.markRejected(s.id);
    }
    this.maybeUnlockEditor();
  }

  /** Ends the review entirely and unlocks the editor. */
  dismissQuillReview(): void {
    this.editorReview.clear();
    this.editor()?.clearAllReviewDecorations();
    this.decoratedReviewIds.clear();
    this.editor()?.setEditable(true);
  }

  onQuillSuggestionHover(s: ReviewSuggestion): void {
    if (s.status !== 'open') return;
    this.editor()?.emphasizeDecoration(s.id);
  }

  onQuillSuggestionLeave(): void {
    this.editor()?.clearEmphasis();
  }

  /** Clicking a card scrolls the document to its highlight. */
  scrollToQuillSuggestion(s: ReviewSuggestion): void {
    if (s.status !== 'open') return;
    this.editor()?.scrollToDecoration(s.id);
  }

  /** Re-opens a resolved suggestion; reverts the edit if it was accepted. */
  undoQuillSuggestion(s: ReviewSuggestion): void {
    if (s.status === 'accepted' && s.type !== 'comment') {
      const reverted = this.editor()?.revertSuggestionEdit(s);
      if (!reverted) {
        this.snackBar.open("Couldn't undo — the text has changed since.", 'OK', { duration: 3000 });
        return;
      }
    }
    this.editorReview.markOpen(s.id);
    this.editor()?.setEditable(false); // re-lock while it's open again
  }

  /** Toggles the free-form refine box for a suggestion. */
  toggleQuillRefine(s: ReviewSuggestion): void {
    if (this.quillRefineOpenId() === s.id) {
      this.quillRefineOpenId.set(null);
    } else {
      this.quillRefineOpenId.set(s.id);
      this.quillRefineText.set('');
    }
  }

  /** Sends the author's free-form instruction and updates the suggestion in place. */
  async submitQuillRefine(s: ReviewSuggestion): Promise<void> {
    const instruction = this.quillRefineText().trim();
    const chapterId = this.chapterId();
    if (!instruction || !chapterId || this.quillRefiningId()) return;
    this.quillRefiningId.set(s.id);
    const blockText = this.editor()?.getReviewBlockText(s.blockIndex) ?? '';
    const result = await this.editorReview.refineSuggestion({
      chapterId,
      blockText,
      originalText: s.originalText,
      currentReplacement: s.replacementText ?? '',
      reason: s.reason,
      instruction,
      category: s.category,
      severity: s.severity,
    });
    this.quillRefiningId.set(null);
    if (!result) {
      this.snackBar.open('Could not refine that suggestion — try rephrasing.', 'OK', { duration: 3000 });
      return;
    }
    this.editorReview.updateSuggestion(s.id, result);
    const updated = this.editorReview.suggestions().find(x => x.id === s.id);
    if (updated) this.editor()?.updateReviewSuggestion(updated);
    this.quillRefineOpenId.set(null);
    this.quillRefineText.set('');
  }

  toggleQuillEdit(s: ReviewSuggestion): void {
    if (this.quillEditOpenId() === s.id) {
      this.quillEditOpenId.set(null);
    } else {
      this.quillEditOpenId.set(s.id);
      this.quillEditText.set(s.replacementText ?? '');
    }
  }

  acceptQuillSuggestionEdited(s: ReviewSuggestion): void {
    const editedText = this.quillEditText().trim();
    const modified = { ...s, replacementText: editedText };
    const applied = this.editor()?.acceptSuggestionEdit(modified);
    if (applied) {
      this.editorReview.markAccepted(s.id);
    } else {
      this.editorReview.markRejected(s.id);
      this.snackBar.open("Couldn't locate that text — it may have changed.", 'OK', { duration: 3000 });
    }
    this.quillEditOpenId.set(null);
    this.maybeUnlockEditor();
  }

  /** Accept/reject invoked from a decoration's inline popover in the document. */
  handleInlineAction(event: { id: string; action: 'accept' | 'reject' }): void {
    const s = this.editorReview.suggestions().find(x => x.id === event.id);
    if (!s) return;
    if (event.action === 'accept') this.acceptQuillSuggestion(s);
    else this.rejectQuillSuggestion(s);
  }

  /** Reconciles document decorations to match the visible, open suggestions. */
  private reconcileReviewDecorations(): void {
    const editor = this.editor();
    if (!editor) return;
    const desired = new Map(
      this.quillSuggestions().filter(s => s.status === 'open').map(s => [s.id, s] as const),
    );
    for (const id of [...this.decoratedReviewIds]) {
      if (!desired.has(id)) {
        editor.undecorateSuggestion(id);
        this.decoratedReviewIds.delete(id);
      }
    }
    for (const [id, s] of desired) {
      if (!this.decoratedReviewIds.has(id)) {
        editor.decorateSuggestion(s);
        this.decoratedReviewIds.add(id);
      }
    }
  }

  /** Re-enables editing once nothing is left awaiting a decision. */
  private maybeUnlockEditor(): void {
    if (!this.editorReview.running() && !this.editorReview.hasOpenSuggestions()) {
      this.editor()?.setEditable(true);
    }
  }
}
