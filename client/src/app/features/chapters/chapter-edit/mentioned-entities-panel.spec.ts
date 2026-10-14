import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { Entity } from '@shared/models/entity.model';
import { RichTextEditorComponent } from '@app/shared/rich-text-editor/rich-text-editor';
import { MentionedEntitiesPanelComponent } from './mentioned-entities-panel';

function fakeEditor() {
  return {
    countEntityReferences: vi.fn(() => 3),
    scrollToEntityReference: vi.fn(() => 3),
    clearEntitySeekHighlight: vi.fn(),
    setMinimapEntityHighlight: vi.fn(),
  };
}

describe('MentionedEntitiesPanelComponent', () => {
  const hector = { id: 'e1', name: 'Hector', type: 'PERSON' } as Entity;
  const angus = { id: 'e2', name: 'Angus', type: 'PERSON' } as Entity;

  function setup(editor: ReturnType<typeof fakeEditor> | null) {
    const fixture = TestBed.createComponent(MentionedEntitiesPanelComponent);
    fixture.componentRef.setInput('entities', [hector, angus]);
    fixture.componentRef.setInput('editor', editor as unknown as RichTextEditorComponent | null);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  it('highlights the active entity on the minimap', () => {
    const editor = fakeEditor();
    const panel = setup(editor);
    panel.setActive(hector);
    expect(editor.setMinimapEntityHighlight).toHaveBeenCalledWith('e1');
    expect(panel.seekCount()).toBe(3);
  });

  it('switches the minimap highlight when another entity becomes active', () => {
    const editor = fakeEditor();
    const panel = setup(editor);
    panel.setActive(hector);
    panel.setActive(angus);
    expect(editor.setMinimapEntityHighlight).toHaveBeenLastCalledWith('e2');
  });

  it('does not re-highlight when the same entity is set again', () => {
    const editor = fakeEditor();
    const panel = setup(editor);
    panel.setActive(hector);
    panel.setActive(hector);
    expect(editor.setMinimapEntityHighlight).toHaveBeenCalledTimes(1);
  });

  it('clears the minimap highlight when the panel loses the active entity', () => {
    const editor = fakeEditor();
    const panel = setup(editor);
    panel.setActive(hector);
    panel.clearActive();
    expect(editor.setMinimapEntityHighlight).toHaveBeenLastCalledWith(null);
    expect(panel.activeEntity()).toBeNull();
  });

  it('tolerates a missing editor', () => {
    const panel = setup(null);
    expect(() => { panel.setActive(hector); panel.clearActive(); }).not.toThrow();
    expect(panel.seekCount()).toBe(0);
  });
});
