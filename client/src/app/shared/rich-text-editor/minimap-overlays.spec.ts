import { vi } from 'vitest';
import {
  MINIMAP_ISSUE_SELECTOR,
  MINIMAP_NOTE_COLOR,
  MINIMAP_SQUIGGLE_MIN_WIDTH,
  MinimapHit,
  describeMinimapHit,
  groupByAuthorship,
  mergeMinimapBands,
  drawMinimapSquiggle,
  minimapAuthorship,
  minimapHitTest,
  minimapIssueColor,
  truncateForTooltip,
  wheelDeltaToPixels,
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

  describe('mergeMinimapBands', () => {
    it('returns an empty list for no bands', () => {
      expect(mergeMinimapBands([])).toEqual([]);
    });

    it('merges bands on the same line, spanning both and keeping active', () => {
      expect(mergeMinimapBands([
        { y: 10, h: 2, active: false },
        { y: 11, h: 3, active: true },
      ])).toEqual([{ y: 10, h: 4, active: true }]);
    });

    it('keeps separate lines apart and sorts by y', () => {
      expect(mergeMinimapBands([
        { y: 30, h: 2, active: false },
        { y: 10, h: 2, active: false },
      ])).toEqual([
        { y: 10, h: 2, active: false },
        { y: 30, h: 2, active: false },
      ]);
    });

    it('does not mutate its input', () => {
      const input = [{ y: 10, h: 2, active: false }, { y: 10.5, h: 2, active: true }];
      mergeMinimapBands(input);
      expect(input[0]).toEqual({ y: 10, h: 2, active: false });
    });
  });
});

describe('wheelDeltaToPixels', () => {
  it('passes pixel deltas (trackpad swipes) through unchanged', () => {
    expect(wheelDeltaToPixels(42, 0, 20, 600)).toBe(42);
    expect(wheelDeltaToPixels(-17.5, 0, 20, 600)).toBe(-17.5);
  });

  it('scales line deltas by the line height', () => {
    expect(wheelDeltaToPixels(3, 1, 24, 600)).toBe(72);
    expect(wheelDeltaToPixels(-1, 1, 24, 600)).toBe(-24);
  });

  it('scales page deltas by the page height', () => {
    expect(wheelDeltaToPixels(1, 2, 24, 600)).toBe(600);
  });

  it('treats an unknown mode as pixels', () => {
    expect(wheelDeltaToPixels(10, 7, 24, 600)).toBe(10);
  });

  describe('minimapAuthorship', () => {
    const textIn = (html: string, selector: string): Text => {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.querySelector(selector)!.firstChild as Text;
    };

    it('reads AI and edited-AI spans', () => {
      expect(minimapAuthorship(textIn('<span data-ai-generated="true">a</span>', 'span'))).toBe('ai');
      expect(minimapAuthorship(textIn('<span data-ai-generated="modified">a</span>', 'span'))).toBe('edited');
    });

    it('inherits authorship through nested inline elements', () => {
      const t = textIn('<span data-ai-generated="true"><span class="entity-reference">Hector</span></span>', '.entity-reference');
      expect(minimapAuthorship(t)).toBe('ai');
    });

    it('treats unmarked text, unknown values and non-span markers as human', () => {
      expect(minimapAuthorship(textIn('<p>a</p>', 'p'))).toBe('human');
      expect(minimapAuthorship(textIn('<span data-ai-generated="other">a</span>', 'span'))).toBe('human');
      // The editor only colours spans, so a marked <p> reads as human too.
      expect(minimapAuthorship(textIn('<p data-ai-generated="true">a</p>', 'p'))).toBe('human');
    });

    it('treats a detached text node as human', () => {
      expect(minimapAuthorship(document.createTextNode('x'))).toBe('human');
    });
  });

  describe('groupByAuthorship', () => {
    it('groups consecutive text nodes by authorship and skips empty ones', () => {
      const d = document.createElement('div');
      d.innerHTML =
        'Human one <span data-ai-generated="true">AI one <b>AI two</b></span>' +
        '<span data-ai-generated="modified">edited</span> human again';
      d.insertBefore(document.createTextNode(''), d.firstChild);
      const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let n: Node | null;
      while ((n = walker.nextNode())) nodes.push(n as Text);

      const runs = groupByAuthorship(nodes).map(r => [r.authorship, r.first.textContent, r.last.textContent]);
      expect(runs).toEqual([
        ['human', 'Human one ', 'Human one '],
        ['ai', 'AI one ', 'AI two'],
        ['edited', 'edited', 'edited'],
        ['human', ' human again', ' human again'],
      ]);
    });

    it('returns no runs for no text', () => {
      expect(groupByAuthorship([])).toEqual([]);
    });
  });
});
