import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { EditorBridgeService, EditorChapterContext } from './editor-bridge.service';
import { RichTextEditorComponent } from '@app/shared/rich-text-editor/rich-text-editor';
import { ChapterEditProposal } from '@shared/models';

function makeEditorStub() {
  return {
    insertExternalText: vi.fn(),
    replaceWithText: vi.fn(),
    scanEntityLinkMatches: vi.fn(() => [{ text: 'Mark', refType: 'first-name', count: 2 }]),
    highlightEntityTerm: vi.fn(() => 3),
    applyEntityTerm: vi.fn(() => 2),
    clearEntityLinkHighlight: vi.fn(),
    restoreFocus: vi.fn(),
    previewSmartEdit: vi.fn(() => true),
    applySmartEdit: vi.fn(() => true),
    clearSmartEditPreview: vi.fn(),
    captureAiContext: vi.fn(() => ({ surroundingText: 'around cursor', selectedText: 'picked' })),
  };
}

const proposal: ChapterEditProposal = {
  kind: 'replace',
  anchorText: 'old prose',
  newText: 'new prose',
  explanation: 'tighter',
};

const context: EditorChapterContext = { chapterId: 'ch-1', seriesId: 's-1' };

describe('EditorBridgeService', () => {
  let service: EditorBridgeService;
  let editor: ReturnType<typeof makeEditorStub>;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(EditorBridgeService);
    editor = makeEditorStub();
  });

  function register(): void {
    service.register(editor as unknown as RichTextEditorComponent);
  }

  describe('registration and chapter context', () => {
    it('tracks whether an editor is registered', () => {
      expect(service.hasEditor()).toBe(false);
      register();
      expect(service.hasEditor()).toBe(true);
      service.unregister();
      expect(service.hasEditor()).toBe(false);
    });

    it('unregister also drops the chapter context', () => {
      register();
      service.setChapterContext(context);
      expect(service.hasChapterContext()).toBe(true);
      service.unregister();
      expect(service.hasChapterContext()).toBe(false);
    });

    it('updateChapterOutlineAndNotes merges into the existing context', () => {
      register();
      service.setChapterContext(context);
      const outline = [{ id: 'o-1', text: 'Beat one', level: 0 }];
      const notes = [{ id: 'n-1', noteText: 'A note', selectedText: 'prose', createdAt: '2026-01-01' }];
      service.updateChapterOutlineAndNotes(outline, notes);

      const captured = service.captureContext();
      expect(captured?.chapterId).toBe('ch-1');
      expect(captured?.outline).toEqual(outline);
      expect(captured?.notes).toEqual(notes);
    });

    it('updateChapterOutlineAndNotes is a no-op without a context', () => {
      register();
      service.updateChapterOutlineAndNotes([], []);
      expect(service.hasChapterContext()).toBe(false);
    });
  });

  describe('captureContext', () => {
    it('snapshots chapter plus the editor surroundings', () => {
      register();
      service.setChapterContext(context);
      expect(service.captureContext()).toEqual({
        chapterId: 'ch-1',
        seriesId: 's-1',
        surroundingText: 'around cursor',
        selectedText: 'picked',
      });
    });

    it('returns null when no editor is registered', () => {
      service.setChapterContext(context);
      expect(service.captureContext()).toBeNull();
    });

    it('returns null when no chapter context is set', () => {
      register();
      expect(service.captureContext()).toBeNull();
    });
  });

  describe('delegation to the active editor', () => {
    beforeEach(register);

    it('forwards text insertion and replacement', () => {
      service.insertText('hello');
      expect(editor.insertExternalText).toHaveBeenCalledWith('hello');
      service.replaceContent('whole chapter');
      expect(editor.replaceWithText).toHaveBeenCalledWith('whole chapter');
    });

    it('forwards entity link operations and returns their results', () => {
      expect(service.scanEntityLinks([{ text: 'Mark', refType: 'first-name' }]))
        .toEqual([{ text: 'Mark', refType: 'first-name', count: 2 }]);
      expect(service.highlightEntityTerm('Mark')).toBe(3);
      expect(service.applyEntityTerm('ent-1', 'Mark', 'first-name')).toBe(2);
      expect(editor.applyEntityTerm).toHaveBeenCalledWith('ent-1', 'Mark', 'first-name');
    });

    it('forwards smart-edit preview/apply/clear', () => {
      expect(service.previewChapterEdit(proposal)).toBe(true);
      expect(editor.previewSmartEdit).toHaveBeenCalledWith(proposal);
      expect(service.applyChapterEdit(proposal)).toBe(true);
      service.clearEditPreview();
      expect(editor.clearSmartEditPreview).toHaveBeenCalled();
    });
  });

  describe('safe defaults with no editor', () => {
    it('returns falsy/empty results instead of throwing', () => {
      expect(() => service.insertText('x')).not.toThrow();
      expect(service.scanEntityLinks([])).toEqual([]);
      expect(service.highlightEntityTerm('Mark')).toBe(0);
      expect(service.applyEntityTerm('e', 'Mark', 'r')).toBe(0);
      expect(service.previewChapterEdit(proposal)).toBe(false);
      expect(service.applyChapterEdit(proposal)).toBe(false);
    });
  });

  describe('draftAccepted$', () => {
    it('emits when a draft is accepted', () => {
      const seen = vi.fn();
      const sub = service.draftAccepted$.subscribe(seen);
      service.notifyDraftAccepted();
      expect(seen).toHaveBeenCalledTimes(1);
      sub.unsubscribe();
    });
  });
});
