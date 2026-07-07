import { routeOrthogonal, toRoundedPath, labelAnchor, Rect, Point } from './edge-routing';

function isOrthogonal(points: Point[]): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].x !== points[i + 1].x && points[i].y !== points[i + 1].y) return false;
  }
  return true;
}

/** Does any segment of the polyline pass through the rect interior? */
function pathCrossesRect(points: Point[], r: Rect): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.x === b.x) {
      if (a.x > r.x && a.x < r.x + r.w && Math.min(a.y, b.y) < r.y + r.h && Math.max(a.y, b.y) > r.y) return true;
    } else {
      if (a.y > r.y && a.y < r.y + r.h && Math.min(a.x, b.x) < r.x + r.w && Math.max(a.x, b.x) > r.x) return true;
    }
  }
  return false;
}

describe('routeOrthogonal', () => {
  const src: Rect = { x: 0, y: 0, w: 100, h: 50 };

  it('routes an orthogonal path between horizontally separated nodes', () => {
    const tgt: Rect = { x: 400, y: 0, w: 100, h: 50 };
    const path = routeOrthogonal(src, tgt, []);
    expect(path).not.toBeNull();
    expect(isOrthogonal(path!)).toBe(true);
    // Anchors sit on the facing sides of each rect.
    expect(path![0]).toEqual({ x: 100, y: 25 });
    expect(path![path!.length - 1]).toEqual({ x: 400, y: 25 });
  });

  it('routes from top/bottom sides when nodes are vertically separated', () => {
    const tgt: Rect = { x: 0, y: 300, w: 100, h: 50 };
    const path = routeOrthogonal(src, tgt, []);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 50, y: 50 });
    expect(path![path!.length - 1]).toEqual({ x: 50, y: 300 });
  });

  it('routes around an obstacle between the nodes', () => {
    const tgt: Rect = { x: 400, y: 0, w: 100, h: 50 };
    const obstacle: Rect = { x: 220, y: -100, w: 60, h: 250 };
    const path = routeOrthogonal(src, tgt, [obstacle]);
    expect(path).not.toBeNull();
    expect(isOrthogonal(path!)).toBe(true);
    expect(pathCrossesRect(path!, obstacle)).toBe(false);
    // Going around requires at least one bend.
    expect(path!.length).toBeGreaterThan(2);
  });

  it('returns null when the nodes are too close together', () => {
    const tgt: Rect = { x: 110, y: 0, w: 100, h: 50 };
    expect(routeOrthogonal(src, tgt, [])).toBeNull();
  });

  it('returns null when an anchor is buried inside an obstacle', () => {
    const tgt: Rect = { x: 400, y: 0, w: 100, h: 50 };
    // Obstacle fully covering the source's right anchor stub.
    const obstacle: Rect = { x: 90, y: -50, w: 80, h: 150 };
    expect(routeOrthogonal(src, tgt, [obstacle])).toBeNull();
  });

  it('applies the lane offset to the anchors', () => {
    const tgt: Rect = { x: 400, y: 0, w: 100, h: 50 };
    const path = routeOrthogonal(src, tgt, [], 10);
    expect(path![0]).toEqual({ x: 100, y: 35 });
  });

  it('clamps the lane offset so anchors stay on the node side', () => {
    const tgt: Rect = { x: 400, y: 0, w: 100, h: 50 };
    const path = routeOrthogonal(src, tgt, [], 1000);
    // Max offset is h/2 - 8 = 17 → y = 25 + 17 = 42, still on the rect edge.
    expect(path![0]).toEqual({ x: 100, y: 42 });
  });
});

describe('toRoundedPath', () => {
  it('returns an empty string for no points', () => {
    expect(toRoundedPath([])).toBe('');
  });

  it('emits a bare move for a single point', () => {
    expect(toRoundedPath([{ x: 3, y: 4 }])).toBe('M 3 4');
  });

  it('draws a straight segment with no corner commands', () => {
    const d = toRoundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(d).toBe('M 0 0 L 10 0');
  });

  it('rounds a corner with a quadratic curve through the corner point', () => {
    const d = toRoundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    // Approach stops short of the corner, curves through it, then continues.
    expect(d).toBe('M 0 0 L 92 0 Q 100 0 100 8 L 100 100');
  });

  it('shrinks the corner radius on short segments', () => {
    const d = toRoundedPath([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 100 }]);
    // Radius is capped at half the incoming segment length (3), not the full 8.
    expect(d).toBe('M 0 0 L 3 0 Q 6 0 6 3 L 6 100');
  });
});

describe('labelAnchor', () => {
  it('anchors above the midpoint of the longest segment', () => {
    const anchor = labelAnchor([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 100 },
    ]);
    expect(anchor).toEqual({ x: 10, y: 44 });
  });

  it('handles a simple two-point line', () => {
    expect(labelAnchor([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toEqual({ x: 50, y: -6 });
  });
});
