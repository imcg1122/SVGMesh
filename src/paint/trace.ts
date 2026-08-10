/**
 * Turn a filled/empty raster into polygon outlines.
 *
 * Part mode needs real geometry to extrude. SVG files provide that directly via
 * their paths, but text does not: glyph outlines aren't reachable from the
 * browser's text APIs, only the pixels they produce. Rather than bundle font
 * files and a font parser, we render the text with the system font and trace
 * the result.
 *
 * The same tracer rescues SVGs whose art is all strokes and no fills, which
 * SVGLoader legitimately turns into zero shapes.
 *
 * Method: every filled cell contributes those of its four sides that face an
 * empty neighbour, as directed edges wound consistently around the cell. Shared
 * sides between two filled cells cancel out by never being emitted, so the
 * survivors chain into closed loops — outer boundaries in one direction, holes
 * in the other. Signed area then separates them, and each hole is assigned to
 * the outer loop containing it.
 *
 * The result is a staircase at cell resolution, so it's simplified afterwards.
 * Pure functions over a boolean grid: no DOM, no Three.js, fully testable.
 */

export type Pt = readonly [number, number];

export interface Polygon {
  /** Outer boundary, in the same units as the grid. */
  outer: Pt[];
  /** Enclosed holes. */
  holes: Pt[][];
}

const key = (x: number, y: number) => `${x},${y}`;

/** Signed area. Sign tells us winding; magnitude tells us which loops matter. */
export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return a / 2;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Extract closed boundary loops from a binary grid.
 * Coordinates are grid units: a cell at (x, y) spans x..x+1, y..y+1.
 */
export function traceLoops(filled: (x: number, y: number) => boolean, w: number, h: number): Pt[][] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && filled(x, y);

  // start -> list of ends. Directed, wound clockwise around each filled cell in
  // grid coordinates; shared interior sides are simply never emitted.
  const out = new Map<string, Pt[]>();
  const push = (a: Pt, b: Pt) => {
    const k = key(a[0], a[1]);
    const list = out.get(k);
    if (list) list.push(b);
    else out.set(k, [b]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) push([x, y], [x + 1, y]);
      if (!at(x + 1, y)) push([x + 1, y], [x + 1, y + 1]);
      if (!at(x, y + 1)) push([x + 1, y + 1], [x, y + 1]);
      if (!at(x - 1, y)) push([x, y + 1], [x, y]);
    }
  }

  const loops: Pt[][] = [];
  for (const [startKey, ends] of out) {
    while (ends.length > 0) {
      const start: Pt = startKey.split(',').map(Number) as unknown as Pt;
      const loop: Pt[] = [start];
      let cur = ends.pop()!;

      // Follow the chain until it closes. Bounded by edge count, so a corrupt
      // grid can't spin forever.
      let guard = w * h * 4 + 8;
      while ((cur[0] !== start[0] || cur[1] !== start[1]) && guard-- > 0) {
        loop.push(cur);
        const nexts = out.get(key(cur[0], cur[1]));
        if (!nexts || nexts.length === 0) break;
        cur = nexts.pop()!;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

/** Ramer–Douglas–Peucker. Collapses the staircase into straight runs. */
export function simplify(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 3 || tolerance <= 0) return pts;

  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;

  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    const [ax, ay] = pts[first];
    const [bx, by] = pts[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;

    let worst = -1;
    let worstI = -1;
    for (let i = first + 1; i < last; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        worstI = i;
      }
    }

    if (worst > tolerance) {
      keep[worstI] = 1;
      stack.push([first, worstI], [worstI, last]);
    }
  }

  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Ramer–Douglas–Peucker for a CLOSED loop.
 *
 * Plain RDP pins the first and last points, which for a loop is wrong twice
 * over: the starting point is wherever tracing happened to begin — usually
 * mid-edge — so it survives as a spurious vertex, and the result depends on
 * where tracing started. Anchoring at an extreme point (always a true corner)
 * and splitting the loop at the point farthest from it gives two open runs that
 * ordinary RDP handles correctly.
 */
export function simplifyClosed(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 4 || tolerance <= 0) return pts;

  let anchor = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] < pts[anchor][0] || (pts[i][0] === pts[anchor][0] && pts[i][1] < pts[anchor][1])) {
      anchor = i;
    }
  }
  const rot = [...pts.slice(anchor), ...pts.slice(0, anchor)];

  let split = 1;
  let best = -1;
  for (let i = 1; i < rot.length; i++) {
    const d = Math.hypot(rot[i][0] - rot[0][0], rot[i][1] - rot[0][1]);
    if (d > best) {
      best = d;
      split = i;
    }
  }

  const a = simplify(rot.slice(0, split + 1), tolerance);
  const b = simplify([...rot.slice(split), rot[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/**
 * Group loops into outer boundaries with their holes.
 *
 * CONVENTION: `traceLoops` winds outer boundaries so their signed area is
 * NEGATIVE and holes POSITIVE. That falls out of walking each filled cell's
 * sides clockwise in grid coordinates, where y increases downward.
 *
 * Each hole is nested in the SMALLEST outer that contains it, so a counter
 * inside a letter inside a larger shape lands in the right place. A hole with
 * no container is discarded rather than promoted to an outline.
 */
export function groupLoops(loops: Pt[][], minArea = 0): Polygon[] {
  const scored = loops
    .map((pts) => ({ pts, area: signedArea(pts) }))
    .filter((l) => Math.abs(l.area) > minArea);

  const outers = scored.filter((l) => l.area < 0).sort((a, b) => Math.abs(a.area) - Math.abs(b.area));
  const holes = scored.filter((l) => l.area > 0);

  const polys: Polygon[] = outers.map((o) => ({ outer: o.pts, holes: [] }));

  for (const hole of holes) {
    const probe = hole.pts[0];
    // outers is sorted smallest-first, so the first container is the tightest.
    const idx = outers.findIndex((o) => pointInPolygon(probe, o.pts));
    if (idx >= 0) polys[idx].holes.push(hole.pts);
  }

  return polys;
}

export interface TraceOptions {
  /** Simplification tolerance in grid cells. */
  tolerance?: number;
  /** Discard specks smaller than this many cells of area. */
  minArea?: number;
  /** Scale output so the grid maps to 0..1 on each axis. */
  normalize?: boolean;
}

/** Trace a binary grid into simplified polygons with holes. */
export function traceToPolygons(
  filled: (x: number, y: number) => boolean,
  w: number,
  h: number,
  opts: TraceOptions = {},
): Polygon[] {
  const { tolerance = 1, minArea = 4, normalize = true } = opts;

  const loops = traceLoops(filled, w, h).map((l) => simplifyClosed(l, tolerance));
  const polys = groupLoops(loops, minArea);
  if (!normalize) return polys;

  const scale = (pts: Pt[]): Pt[] => pts.map(([x, y]) => [x / w, y / h] as Pt);
  return polys.map((p) => ({ outer: scale(p.outer), holes: p.holes.map(scale) }));
}
