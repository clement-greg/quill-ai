import { Injectable, signal, computed } from '@angular/core';
import { RichTextEditorComponent } from '../shared/rich-text-editor/rich-text-editor';

/** The chapter an active editor belongs to, so external tools (e.g. Ask Quill)
 * can ground answers in the chapter and insert at the cursor. */
export interface EditorChapterContext {
  chapterId: string;
  seriesId: string | null;
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

  insertText(text: string): void {
    this._editor()?.insertExternalText(text);
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
