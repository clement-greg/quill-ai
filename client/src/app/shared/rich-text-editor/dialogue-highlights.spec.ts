import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { DialogueHighlightsService, NARRATION_HIGHLIGHT, speakerHighlight } from './dialogue-highlights';

describe('DialogueHighlightsService', () => {
  function setup(saved?: string) {
    const registry = new Map<string, { ranges: Range[]; priority: number }>();
    const storage = new Map<string, string>(saved ? [['quill_dialogue_speakers', saved]] : []);
    class FakeHighlight { priority = 0; ranges: Range[]; constructor(...r: Range[]) { this.ranges = r; } }
    const win = {
      CSS: { highlights: { set: (n: string, v: FakeHighlight) => registry.set(n, v), delete: (n: string) => registry.delete(n) } },
      Highlight: FakeHighlight,
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    };
    TestBed.configureTestingModule({ providers: [{ provide: DOCUMENT, useValue: { defaultView: win } }] });
    return { svc: TestBed.inject(DialogueHighlightsService), registry, storage };
  }

  it('combines every editor\'s ranges per highlight and clears an editor\'s on remove', () => {
    const { svc, registry } = setup();
    const [a, b, c] = [new Range(), new Range(), new Range()];
    const one = {}; const two = {};
    svc.update(one, new Map([[speakerHighlight(0), [a]]]));
    svc.update(two, new Map([[speakerHighlight(0), [b]], [NARRATION_HIGHLIGHT, [c]]]));
    expect(registry.get('dialogue-0')!.ranges).toEqual([a, b]);
    expect(registry.get('dialogue-0')!.priority).toBe(-1);
    expect(registry.get('dialogue-none')!.ranges).toEqual([c]);
    svc.remove(two);
    expect(registry.get('dialogue-0')!.ranges).toEqual([a]);
    expect(registry.has('dialogue-none')).toBe(false);
  });

  it('wraps speaker slots around the palette', () => {
    expect(speakerHighlight(9)).toBe('dialogue-1');
  });

  it('is on by default and remembers being turned off', () => {
    const { svc, storage } = setup();
    expect(svc.visible()).toBe(true);
    svc.setVisible(false);
    expect(svc.visible()).toBe(false);
    expect(storage.get('quill_dialogue_speakers')).toBe('off');
    TestBed.resetTestingModule();
    expect(setup('off').svc.visible()).toBe(false);
  });
});
