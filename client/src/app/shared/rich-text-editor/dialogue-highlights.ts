import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { UserSettingsService } from '@app/core/services/user-settings.service';

/**
 * Speaker colors, by slot. ::highlight(dialogue-N) in styles.css paints slot N
 * with the same color, so keep the two lists in step.
 */
export const SPEAKER_COLORS = ['#1e88e5', '#e53935', '#43a047', '#8e24aa', '#f4511e', '#00897b', '#d81b60', '#6d4c41'] as const;

/** Highlight names: one per speaker slot, then lines read in the narration voice, then lines not attributed yet. */
export const speakerHighlight = (slot: number) => `dialogue-${slot % SPEAKER_COLORS.length}`;
export const NARRATION_HIGHLIGHT = 'dialogue-none';
export const PENDING_HIGHLIGHT = 'dialogue-pending';
/** Not attributed yet, and being worked out right now. */
export const WORKING_HIGHLIGHT = 'dialogue-working';
const NAMES = [...SPEAKER_COLORS.map((_, i) => speakerHighlight(i)), NARRATION_HIGHLIGHT, PENDING_HIGHLIGHT, WORKING_HIGHLIGHT];

interface HighlightRegistry { set(name: string, value: unknown): void; delete(name: string): void }
type HighlightCtor = new (...ranges: Range[]) => { priority: number };

/**
 * Paints who speaks each line of dialogue with the CSS Custom Highlight API,
 * which colors text without touching the DOM, so nothing leaks into saved
 * chapters. Each editor (one per chapter in the full-book editor) reports its
 * ranges here; the named highlights hold every editor's ranges together.
 */
@Injectable({ providedIn: 'root' })
export class DialogueHighlightsService {
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly settings = inject(UserSettingsService);
  private readonly owners = new Map<object, ReadonlyMap<string, readonly Range[]>>();

  /** Speaker colors are on (a user setting, "Color dialogue by speaker"). */
  readonly visible = this.settings.dialogueMarkupEnabled;

  setVisible(visible: boolean): void {
    this.settings.setDialogueMarkupEnabled(visible);
  }

  /** Replaces one editor's ranges, grouped by highlight name. */
  update(owner: object, groups: ReadonlyMap<string, readonly Range[]>): void {
    this.owners.set(owner, groups);
    this.render();
  }

  remove(owner: object): void {
    if (this.owners.delete(owner)) this.render();
  }

  private render(): void {
    const css = (this.win as { CSS?: { highlights?: HighlightRegistry } } | null)?.CSS;
    const Highlight = (this.win as { Highlight?: HighlightCtor } | null)?.Highlight;
    if (!css?.highlights || !Highlight) return;
    for (const name of NAMES) {
      const ranges = [...this.owners.values()].flatMap(groups => groups.get(name) ?? []);
      if (!ranges.length) { css.highlights.delete(name); continue; }
      const highlight = new Highlight(...ranges);
      // Below the read-aloud and search highlights.
      highlight.priority = -1;
      css.highlights.set(name, highlight);
    }
  }
}
