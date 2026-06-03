import { Injectable, signal, computed } from '@angular/core';
import { RichTextEditorComponent } from '../shared/rich-text-editor/rich-text-editor';

@Injectable({ providedIn: 'root' })
export class EditorBridgeService {
  private readonly _editor = signal<RichTextEditorComponent | null>(null);
  readonly hasEditor = computed(() => this._editor() !== null);

  register(editor: RichTextEditorComponent): void {
    this._editor.set(editor);
  }

  unregister(): void {
    this._editor.set(null);
  }

  insertText(text: string): void {
    this._editor()?.insertExternalText(text);
  }
}
