import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { Entity } from '@shared/models/entity.model';
import { RichTextEditorComponent } from '@app/shared/rich-text-editor/rich-text-editor';
import { signal } from '@angular/core';
import { DialogueHighlightsService } from '@app/shared/rich-text-editor/dialogue-highlights';
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

  let focusedSpeaker: ReturnType<typeof signal<string | null>>;

  function setup(editor: ReturnType<typeof fakeEditor> | null) {
    focusedSpeaker = signal<string | null>(null);
    TestBed.configureTestingModule({
      providers: [{ provide: DialogueHighlightsService, useValue: { focusedSpeaker } }],
    });
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

  it('colors the active entity\'s dialogue, and stops when it is cleared', () => {
    const panel = setup(fakeEditor());
    panel.setActive(hector);
    expect(focusedSpeaker()).toBe('e1');
    panel.setActive(angus);
    expect(focusedSpeaker()).toBe('e2');
    panel.clearActive();
    expect(focusedSpeaker()).toBeNull();
  });

  it('stops coloring dialogue when destroyed mid-hover', () => {
    const fixture = TestBed.createComponent(MentionedEntitiesPanelComponent);
    fixture.componentRef.setInput('entities', [hector]);
    fixture.detectChanges();
    focusedSpeaker = TestBed.inject(DialogueHighlightsService).focusedSpeaker as typeof focusedSpeaker;
    fixture.componentInstance.setActive(hector);
    expect(focusedSpeaker()).toBe('e1');
    fixture.destroy();
    expect(focusedSpeaker()).toBeNull();
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
