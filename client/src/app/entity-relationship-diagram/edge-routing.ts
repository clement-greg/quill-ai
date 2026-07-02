// Orthogonal edge routing for the relationship diagram.
// Pure geometry — no Angular dependencies.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

const MARGIN = 16; // obstacle inflation + anchor stub length
const BEND_PENALTY = 40;
const CORNER_RADIUS = 8;

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function pointInRect(p: Point, r: Rect): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

// Does the axis-aligned segment from a to b pass through the rect interior?
function segmentHitsRect(a: Point, b: Point, r: Rect): boolean {
  if (a.x === b.x) {
    // vertical
    if (a.x <= r.x || a.x >= r.x + r.w) return false;
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    return y1 < r.y + r.h && y2 > r.y;
  }
  // horizontal
  if (a.y <= r.y || a.y >= r.y + r.h) return false;
  const x1 = Math.min(a.x, b.x);
  const x2 = Math.max(a.x, b.x);
  return x1 < r.x + r.w && x2 > r.x;
}

type Side = 'left' | 'right' | 'top' | 'bottom';

function sideAnchor(rect: Rect, side: Side, laneOffset: number): { anchor: Point; stub: Point } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  // Clamp the lane offset so anchors stay on the node's side.
  const offX = Math.max(-rect.w / 2 + 8, Math.min(rect.w / 2 - 8, laneOffset));
  const offY = Math.max(-rect.h / 2 + 8, Math.min(rect.h / 2 - 8, laneOffset));
  switch (side) {
    case 'left': {
      const anchor = { x: rect.x, y: cy + offY };
      return { anchor, stub: { x: rect.x - MARGIN, y: anchor.y } };
    }
    case 'right': {
      const anchor = { x: rect.x + rect.w, y: cy + offY };
      return { anchor, stub: { x: rect.x + rect.w + MARGIN, y: anchor.y } };
    }
    case 'top': {
      const anchor = { x: cx + offX, y: rect.y };
      return { anchor, stub: { x: anchor.x, y: rect.y - MARGIN } };
    }
    case 'bottom': {
      const anchor = { x: cx + offX, y: rect.y + rect.h };
      return { anchor, stub: { x: anchor.x, y: rect.y + rect.h + MARGIN } };
    }
  }
}

// A* over a sparse grid of "interesting" coordinates, avoiding inflated obstacles.
function aStar(start: Point, goal: Point, obstacles: Rect[]): Point[] | null {
  const xs = new Set<number>([start.x, goal.x]);
  const ys = new Set<number>([start.y, goal.y]);
  for (const r of obstacles) {
    xs.add(r.x);
    xs.add(r.x + r.w);
    ys.add(r.y);
    ys.add(r.y + r.h);
  }
  const xList = [...xs].sort((a, b) => a - b);
  const yList = [...ys].sort((a, b) => a - b);
  // Add midpoints between consecutive coordinates so paths can slip between obstacles.
  const withMids = (list: number[]) => {
    const out: number[] = [];
    for (let i = 0; i < list.length; i++) {
      out.push(list[i]);
      if (i + 1 < list.length && list[i + 1] - list[i] > 2) {
        out.push((list[i] + list[i + 1]) / 2);
      }
    }
    return out;
  };
  const gx = withMids(xList);
  const gy = withMids(yList);
  const xIndex = new Map(gx.map((v, i) => [v, i]));
  const yIndex = new Map(gy.map((v, i) => [v, i]));

  const startXi = xIndex.get(start.x)!;
  const startYi = yIndex.get(start.y)!;
  const goalXi = xIndex.get(goal.x)!;
  const goalYi = yIndex.get(goal.y)!;

  // If either endpoint sits inside an inflated obstacle, routing can't help.
  if (obstacles.some((r) => pointInRect(start, r) || pointInRect(goal, r))) return null;

  interface Node {
    xi: number;
    yi: number;
    dir: number; // 0..3 or -1 for start
    g: number;
    f: number;
    parent: Node | null;
  }
  const DIRS = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  const key = (xi: number, yi: number, dir: number) => (xi * gy.length + yi) * 5 + dir + 1;
  const heuristic = (xi: number, yi: number) =>
    Math.abs(gx[xi] - gx[goalXi]) + Math.abs(gy[yi] - gy[goalYi]);

  const open: Node[] = [{ xi: startXi, yi: startYi, dir: -1, g: 0, f: heuristic(startXi, startYi), parent: null }];
  const best = new Map<number, number>();
  let iterations = 0;
  const MAX_ITERATIONS = 20000;

  while (open.length > 0) {
    if (++iterations > MAX_ITERATIONS) return null;
    // Small frontier in practice; linear extract-min is fine.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];

    if (cur.xi === goalXi && cur.yi === goalYi) {
      const points: Point[] = [];
      for (let n: Node | null = cur; n; n = n.parent) {
        points.unshift({ x: gx[n.xi], y: gy[n.yi] });
      }
      return points;
    }

    const k = key(cur.xi, cur.yi, cur.dir);
    const seen = best.get(k);
    if (seen !== undefined && seen < cur.g) continue;

    for (let d = 0; d < 4; d++) {
      const nxi = cur.xi + DIRS[d].dx;
      const nyi = cur.yi + DIRS[d].dy;
      if (nxi < 0 || nxi >= gx.length || nyi < 0 || nyi >= gy.length) continue;
      const from = { x: gx[cur.xi], y: gy[cur.yi] };
      const to = { x: gx[nxi], y: gy[nyi] };
      if (obstacles.some((r) => segmentHitsRect(from, to, r) || pointInRect(to, r))) continue;
      const step = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
      const g = cur.g + step + (cur.dir !== -1 && cur.dir !== d ? BEND_PENALTY : 0);
      const nk = key(nxi, nyi, d);
      const prev = best.get(nk);
      if (prev !== undefined && prev <= g) continue;
      best.set(nk, g);
      open.push({ xi: nxi, yi: nyi, dir: d, g, f: g + heuristic(nxi, nyi), parent: cur });
    }
  }
  return null;
}

function dropCollinear(points: Point[]): Point[] {
  if (points.length <= 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    if (!collinear) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Route an orthogonal path from srcRect to tgtRect around the obstacle rects.
 * Returns null when no sensible route exists (caller should fall back to a
 * straight line). Obstacles must exclude src and tgt.
 */
export function routeOrthogonal(
  srcRect: Rect,
  tgtRect: Rect,
  obstacles: Rect[],
  laneOffset = 0
): Point[] | null {
  // Too close/overlapping — straight line looks better than a contorted route.
  if (rectsIntersect(inflate(srcRect, MARGIN), inflate(tgtRect, MARGIN))) return null;

  const dx = tgtRect.x + tgtRect.w / 2 - (srcRect.x + srcRect.w / 2);
  const dy = tgtRect.y + tgtRect.h / 2 - (srcRect.y + srcRect.h / 2);
  let srcSide: Side;
  let tgtSide: Side;
  if (Math.abs(dx) >= Math.abs(dy)) {
    srcSide = dx > 0 ? 'right' : 'left';
    tgtSide = dx > 0 ? 'left' : 'right';
  } else {
    srcSide = dy > 0 ? 'bottom' : 'top';
    tgtSide = dy > 0 ? 'top' : 'bottom';
  }

  const src = sideAnchor(srcRect, srcSide, laneOffset);
  const tgt = sideAnchor(tgtRect, tgtSide, laneOffset);

  // Inflate slightly less than the stub length so stub endpoints sit outside.
  const inflated = obstacles.map((r) => inflate(r, MARGIN - 1));
  const middle = aStar(src.stub, tgt.stub, inflated);
  if (!middle) return null;

  return dropCollinear([src.anchor, src.stub, ...middle, tgt.stub, tgt.anchor]);
}

/** Build an SVG path string with rounded corners from an orthogonal polyline. */
export function toRoundedPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const lenIn = Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
    const lenOut = Math.abs(next.x - cur.x) + Math.abs(next.y - cur.y);
    const r = Math.min(CORNER_RADIUS, lenIn / 2, lenOut / 2);
    const inDir = { x: Math.sign(cur.x - prev.x), y: Math.sign(cur.y - prev.y) };
    const outDir = { x: Math.sign(next.x - cur.x), y: Math.sign(next.y - cur.y) };
    d += ` L ${cur.x - inDir.x * r} ${cur.y - inDir.y * r}`;
    d += ` Q ${cur.x} ${cur.y} ${cur.x + outDir.x * r} ${cur.y + outDir.y * r}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Midpoint of the longest segment, nudged up so the label sits above the line. */
export function labelAnchor(points: Point[]): Point {
  let best = { x: (points[0].x + points[points.length - 1].x) / 2, y: (points[0].y + points[points.length - 1].y) / 2 };
  let bestLen = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return { x: best.x, y: best.y - 6 };
}
