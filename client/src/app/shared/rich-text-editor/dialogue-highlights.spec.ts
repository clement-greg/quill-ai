import { DOCUMENT } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UserSettingsService } from '@app/core/services/user-settings.service';
import { DialogueHighlightsService, NARRATION_HIGHLIGHT, speakerHighlight } from './dialogue-highlights';

describe('DialogueHighlightsService', () => {
  function setup() {
    const registry = new Map<string, { ranges: Range[]; priority: number }>();
    class FakeHighlight { priority = 0; ranges: Range[]; constructor(...r: Range[]) { this.ranges = r; } }
    const win = {
      CSS: { highlights: { set: (n: string, v: FakeHighlight) => registry.set(n, v), delete: (n: string) => registry.delete(n) } },
      Highlight: FakeHighlight,
    };
    const enabled = signal(true);
    const settings = { dialogueMarkupEnabled: enabled, setDialogueMarkupEnabled: vi.fn((v: boolean) => enabled.set(v)) };
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { defaultView: win } }, { provide: UserSettingsService, useValue: settings }],
    });
    return { svc: TestBed.inject(DialogueHighlightsService), registry, settings };
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

  it('follows the "Color dialogue by speaker" setting', () => {
    const { svc, settings } = setup();
    expect(svc.visible()).toBe(true);
    svc.setVisible(false);
    expect(settings.setDialogueMarkupEnabled).toHaveBeenCalledWith(false);
    expect(svc.visible()).toBe(false);
  });
});
