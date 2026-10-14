import { vi } from 'vitest';
import {
  MINIMAP_ISSUE_SELECTOR,
  MINIMAP_NOTE_COLOR,
  MINIMAP_SQUIGGLE_MIN_WIDTH,
  MinimapHit,
  describeMinimapHit,
  drawMinimapSquiggle,
  minimapHitTest,
  minimapIssueColor,
  truncateForTooltip,
} from './minimap-overlays';

function fakeCtx() {
  return {
    strokeStyle: '' as unknown,
    lineWidth: 0,
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  };
}

describe('minimap overlays', () => {
  describe('MINIMAP_ISSUE_SELECTOR', () => {
    it('matches grammar errors and Quill Editor suggestions only', () => {
      const root = document.createElement('div');
      root.innerHTML =
        '<mark class="grammar-error">a</mark>' +
        '<span class="quill-suggestion-mark">b</span>' +
        '<mark class="quill-review-highlight">c</mark>' +
        '<span class="entity-reference">d</span>';
      const hits = Array.from(root.querySelectorAll(MINIMAP_ISSUE_SELECTOR)).map(e => e.textContent);
      expect(hits).toEqual(['a', 'b']);
    });
  });

  describe('minimapIssueColor', () => {
    const el = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.firstElementChild!;
    };

    it('uses red for grammar errors', () => {
      expect(minimapIssueColor(el('<mark class="grammar-error">x</mark>'))).toBe('rgba(211, 47, 47, 0.95)');
    });

    it('colours suggestions by severity', () => {
      expect(minimapIssueColor(el('<span class="quill-suggestion-mark" data-severity="high"></span>')))
        .toBe('rgba(229, 57, 53, 0.95)');
      expect(minimapIssueColor(el('<span class="quill-suggestion-mark" data-severity="low"></span>')))
        .toBe('rgba(120, 120, 120, 0.85)');
    });

    it('falls back to medium for missing or unknown severity', () => {
      const medium = 'rgba(251, 140, 0, 0.95)';
      expect(minimapIssueColor(el('<span class="quill-suggestion-mark"></span>'))).toBe(medium);
      expect(minimapIssueColor(el('<span class="quill-suggestion-mark" data-severity="bogus"></span>'))).toBe(medium);
    });
  });

  describe('drawMinimapSquiggle', () => {
    it('strokes a zig-zag across the requested width in the given colour', () => {
      const ctx = fakeCtx();
      drawMinimapSquiggle(ctx, 10, 20, 12, 'red');

      expect(ctx.strokeStyle).toBe('red');
      expect(ctx.lineWidth).toBe(1.5);
      expect(ctx.moveTo).toHaveBeenCalledWith(10, 20);
      expect(ctx.stroke).toHaveBeenCalledTimes(1);

      const points = ctx.lineTo.mock.calls as [number, number][];
      expect(points[points.length - 1][0]).toBe(22);
      // alternates between the baseline and two pixels above it
      const ys = new Set(points.map(p => p[1]));
      expect(ys).toEqual(new Set([18, 20]));
      for (let i = 1; i < points.length; i++) expect(points[i][1]).not.toBe(points[i - 1][1]);
    });

    it('enforces a minimum width so tiny marks stay visible', () => {
      const ctx = fakeCtx();
      drawMinimapSquiggle(ctx, 0, 5, 0.5, 'red');
      const points = ctx.lineTo.mock.calls as [number, number][];
      expect(points[points.length - 1][0]).toBe(MINIMAP_SQUIGGLE_MIN_WIDTH);
    });
  });

  describe('minimapHitTest', () => {
    const el = document.createElement('span');
    const hit = (y0: number, y1: number, x0 = 0, x1 = 80): MinimapHit =>
      ({ kind: 'grammar', el, x0, x1, y0, y1 });

    it('returns null when nothing contains the point', () => {
      expect(minimapHitTest([hit(10, 20)], 40, 30)).toBeNull();
      expect(minimapHitTest([hit(10, 20, 0, 10)], 40, 15)).toBeNull();
      expect(minimapHitTest([], 0, 0)).toBeNull();
    });

    it('includes the region edges', () => {
      const h = hit(10, 20, 5, 15);
      expect(minimapHitTest([h], 5, 10)).toBe(h);
      expect(minimapHitTest([h], 15, 20)).toBe(h);
    });

    it('prefers the overlapping hit whose centre is nearest', () => {
      const a = hit(10, 20);
      const b = hit(14, 30);
      expect(minimapHitTest([a, b], 40, 15)).toBe(a);
      expect(minimapHitTest([a, b], 40, 19)).toBe(b);
    });
  });

  describe('truncateForTooltip', () => {
    it('collapses whitespace and leaves short text alone', () => {
      expect(truncateForTooltip('  a\n  b\tc ')).toBe('a b c');
    });

    it('cuts long text on a word boundary with an ellipsis', () => {
      const out = truncateForTooltip('alpha beta gamma delta epsilon', 18);
      expect(out).toBe('alpha beta gamma…');
    });

    it('hard-cuts when there is no usable word boundary', () => {
      expect(truncateForTooltip('abcdefghijklmnop', 5)).toBe('abcde…');
    });
  });

  describe('describeMinimapHit', () => {
    const make = (html: string) => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.firstElementChild as HTMLElement;
    };
    const none = () => undefined;

    it('describes a grammar error with its message and fix', () => {
      const el = make('<mark class="grammar-error" data-grammar-message="Agreement" data-grammar-suggestion="were">was</mark>');
      expect(describeMinimapHit({ kind: 'grammar', el }, none)).toEqual({
        title: 'Grammar',
        text: 'Agreement — “was” → “were”',
        color: minimapIssueColor(el),
        clickable: true,
      });
    });

    it('falls back to a generic grammar message', () => {
      const el = make('<mark class="grammar-error">teh</mark>');
      expect(describeMinimapHit({ kind: 'grammar', el }, none).text).toBe('Possible grammar issue — “teh”');
    });

    it('describes a suggestion using its reason, category and severity', () => {
      const el = make('<span class="quill-suggestion-mark" data-suggestion-id="s1" data-severity="high">x</span>');
      const lookup = vi.fn(() => ({ originalText: 'x', category: 'pacing', severity: 'high', reason: 'Drags here' }));
      expect(describeMinimapHit({ kind: 'suggestion', el }, lookup)).toMatchObject({
        title: 'Pacing · high', text: 'Drags here', clickable: true,
      });
      expect(lookup).toHaveBeenCalledWith('s1');
    });

    it('shows the replacement when a suggestion has no reason', () => {
      const el = make('<span class="quill-suggestion-mark" data-suggestion-id="s2">old</span>');
      const out = describeMinimapHit({ kind: 'suggestion', el }, () => ({ originalText: 'old', replacementText: 'new' }));
      expect(out.title).toBe('Suggestion');
      expect(out.text).toBe('“old” → “new”');
    });

    it('still describes a suggestion whose data is missing', () => {
      const el = make('<span class="quill-suggestion-mark" data-severity="low">old</span>');
      expect(describeMinimapHit({ kind: 'suggestion', el }, none)).toMatchObject({ title: 'Suggestion · low', text: '“old”' });
    });

    it('describes a note by its anchored text', () => {
      const el = make('<span class="note-indicator" data-note-id="n1">the dunes</span>');
      expect(describeMinimapHit({ kind: 'note', el }, none)).toEqual({
        title: 'Note', text: '“the dunes”', color: MINIMAP_NOTE_COLOR, clickable: true,
      });
    });
  });
});
