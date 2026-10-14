/** Elements the AI checkers leave in the document that the minimap flags with a squiggle. */
export const MINIMAP_ISSUE_SELECTOR = 'mark.grammar-error, .quill-suggestion-mark';

const GRAMMAR_COLOR = 'rgba(211, 47, 47, 0.95)';
const SEVERITY_COLORS: Record<string, string> = {
  high: 'rgba(229, 57, 53, 0.95)',
  medium: 'rgba(251, 140, 0, 0.95)',
  low: 'rgba(120, 120, 120, 0.85)',
};

/** Squiggle colour for a flagged element, matching its in-editor underline. */
export function minimapIssueColor(el: Element): string {
  if (el.matches('mark.grammar-error')) return GRAMMAR_COLOR;
  return SEVERITY_COLORS[el.getAttribute('data-severity') ?? 'medium'] ?? SEVERITY_COLORS['medium'];
}

/** Narrowest squiggle drawn, so a flagged single word still reads at minimap scale. */
export const MINIMAP_SQUIGGLE_MIN_WIDTH = 10;

/** Strokes a zig-zag "squiggly" underline starting at (x, y), spanning `width` px. */
export function drawMinimapSquiggle(
  ctx: Pick<CanvasRenderingContext2D, 'beginPath' | 'moveTo' | 'lineTo' | 'stroke'> & { strokeStyle: unknown; lineWidth: number },
  x: number,
  y: number,
  width: number,
  color: string,
): void {
  const w = Math.max(MINIMAP_SQUIGGLE_MIN_WIDTH, width);
  const step = 2; // half-wavelength in CSS px
  const amp = 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  let up = true;
  for (let px = x + step; px < x + w; px += step) {
    ctx.lineTo(px, up ? y - amp : y);
    up = !up;
  }
  ctx.lineTo(x + w, up ? y - amp : y);
  ctx.stroke();
}

/** Search-match ticks drawn on the minimap's right edge. */
export const MINIMAP_SEARCH_COLOR = 'rgba(255, 193, 7, 0.95)';
export const MINIMAP_SEARCH_ACTIVE_COLOR = 'rgba(255, 111, 0, 1)';
/** Note markers drawn in the minimap's left gutter (matches the in-editor note underline). */
export const MINIMAP_NOTE_COLOR = 'rgba(249, 168, 37, 1)';

export type MinimapHitKind = 'grammar' | 'suggestion' | 'note';

/** A clickable region on the minimap canvas, in CSS px. */
export interface MinimapHit {
  kind: MinimapHitKind;
  el: HTMLElement;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** The hit containing (x, y) whose vertical centre is closest to y, or null. */
export function minimapHitTest(hits: readonly MinimapHit[], x: number, y: number): MinimapHit | null {
  let best: MinimapHit | null = null;
  let bestDist = Infinity;
  for (const h of hits) {
    if (x < h.x0 || x > h.x1 || y < h.y0 || y > h.y1) continue;
    const dist = Math.abs(y - (h.y0 + h.y1) / 2);
    if (dist < bestDist) { best = h; bestDist = dist; }
  }
  return best;
}

/** Tooltip shown while hovering the minimap. */
export interface MinimapTooltipContent {
  title?: string;
  text: string;
  color?: string;
  clickable?: boolean;
}

/** Shortens `text` to at most `max` chars on a word boundary, adding an ellipsis. */
export function truncateForTooltip(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/** Minimal view of a Quill Editor suggestion needed to describe it. */
export interface MinimapSuggestionInfo {
  originalText: string;
  replacementText?: string;
  category?: string;
  severity?: string;
  reason?: string;
}

/** Builds tooltip content describing a flagged element or note. */
export function describeMinimapHit(
  hit: Pick<MinimapHit, 'kind' | 'el'>,
  lookupSuggestion: (id: string) => MinimapSuggestionInfo | undefined,
): MinimapTooltipContent {
  const el = hit.el;
  const quoted = `“${truncateForTooltip(el.textContent ?? '', 60)}”`;
  if (hit.kind === 'grammar') {
    const message = el.getAttribute('data-grammar-message') || 'Possible grammar issue';
    const suggestion = el.getAttribute('data-grammar-suggestion');
    return {
      title: 'Grammar',
      text: truncateForTooltip(suggestion ? `${message} — ${quoted} → “${suggestion}”` : `${message} — ${quoted}`),
      color: minimapIssueColor(el),
      clickable: true,
    };
  }
  if (hit.kind === 'suggestion') {
    const s = lookupSuggestion(el.getAttribute('data-suggestion-id') ?? '');
    const label = s?.category ? s.category.charAt(0).toUpperCase() + s.category.slice(1) : 'Suggestion';
    const severity = s?.severity ?? el.getAttribute('data-severity');
    const detail = s?.reason
      ?? (s?.replacementText !== undefined ? `${quoted} → “${s.replacementText}”` : quoted);
    return {
      title: severity ? `${label} · ${severity}` : label,
      text: truncateForTooltip(detail),
      color: minimapIssueColor(el),
      clickable: true,
    };
  }
  return { title: 'Note', text: quoted, color: MINIMAP_NOTE_COLOR, clickable: true };
}

/** Highlight for the lines mentioning the hovered entity; distinct from the
 *  teal viewport/caret and the warm issue, note and search colours. */
export const MINIMAP_MENTION_RGB = '142, 68, 230';

/** One horizontal band on the minimap, in CSS px. */
export interface MinimapBand {
  y: number;
  h: number;
  active: boolean;
}

/** Merges bands on the same minimap line (tops within `tol` px) so several
 *  mentions on one line don't stack their translucent fills. The merged band
 *  spans all of them and is active if any of them is. Output is sorted by y. */
export function mergeMinimapBands(bands: readonly MinimapBand[], tol = 1.5): MinimapBand[] {
  const sorted = [...bands].sort((a, b) => a.y - b.y);
  const out: MinimapBand[] = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.y - last.y <= tol) {
      const bottom = Math.max(last.y + last.h, b.y + b.h);
      last.h = bottom - last.y;
      last.active ||= b.active;
    } else {
      out.push({ ...b });
    }
  }
  return out;
}
