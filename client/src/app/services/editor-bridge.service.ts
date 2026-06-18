import { Injectable, signal, computed } from '@angular/core';
import { Subject } from 'rxjs';
import { RichTextEditorComponent } from '../shared/rich-text-editor/rich-text-editor';
import { ChapterNote, OutlineItem } from '@shared/models';

/** The chapter an active editor belongs to, so external tools (e.g. Ask Quill)
 * can ground answers in the chapter and insert at the cursor. */
export interface EditorChapterContext {
  chapterId: string;
  seriesId: string | null;
  outline?: OutlineItem[];
  notes?: ChapterNote[];
}

/** The context captured at the moment an AI assist is requested. */
export interface CapturedEditorContext extends EditorChapterContext {
  surroundingText: string;
  selectedText: string;
}

@Injectable({ providedIn: 'root' })
export class EditorBridgeService {
  private readonly _editor = signal<RichTextEditorComponent | null>(null);
  readonly hasEditor = computed(() => this._editor() !== null);

  private readonly _chapterContext = signal<EditorChapterContext | null>(null);
  /** True when the active editor is a chapter (AI answers can be inserted into it). */
  readonly hasChapterContext = computed(() => this._chapterContext() !== null);

  /** Emits when an AI chapter draft is accepted into the editor, so the host
   * editor can run canon extraction (timeline/relationships) on the new text. */
  private readonly _draftAccepted = new Subject<void>();
  readonly draftAccepted$ = this._draftAccepted.asObservable();

  register(editor: RichTextEditorComponent): void {
    this._editor.set(editor);
  }

  unregister(): void {
    this._editor.set(null);
    this._chapterContext.set(null);
  }

  setChapterContext(context: EditorChapterContext | null): void {
    this._chapterContext.set(context);
  }

  updateChapterOutlineAndNotes(outline: OutlineItem[], notes: ChapterNote[]): void {
    const ctx = this._chapterContext();
    if (!ctx) return;
    this._chapterContext.set({ ...ctx, outline, notes });
  }

  insertText(text: string): void {
    this._editor()?.insertExternalText(text);
  }

  /** Replaces the entire active editor content with the given prose (used by
   * "Replace chapter" on an AI-generated draft). */
  replaceContent(text: string): void {
    this._editor()?.replaceWithText(text);
  }

  /** Signals that an AI chapter draft was just accepted into the editor. */
  notifyDraftAccepted(): void {
    this._draftAccepted.next();
  }

  /** Returns focus to the active editor at its prior cursor position. */
  restoreFocus(): void {
    this._editor()?.restoreFocus();
  }

  /** Snapshots the chapter + cursor surroundings for an AI request, or null when
   * no chapter editor is active. */
  captureContext(): CapturedEditorContext | null {
    const chapter = this._chapterContext();
    const editor = this._editor();
    if (!chapter || !editor) return null;
    const { surroundingText, selectedText } = editor.captureAiContext();
    return { ...chapter, surroundingText, selectedText };
  }
}
