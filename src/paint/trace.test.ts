/**
 * Raster tracing tests. Pure functions over a boolean grid — no DOM, no Three.
 *
 * The cases that matter are topological: a shape with a hole must come back as
 * one polygon with one hole, not two separate outlines, or the extruded letter
 * "O" prints as a filled disc.
 */

import {
  groupLoops,
  pointInPolygon,
  signedArea,
  simplify,
  simplifyClosed,
  traceLoops,
  traceToPolygons,
  type Pt,
} from './trace.ts';

let failures = 0;
let checks = 0;

function check(name: string, got: unknown, want: unknown): void {
  checks++;
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  failures++;
  console.error(`  FAIL  ${name}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`);
}
function ok(name: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${name} ${detail}`);
}
const section = (s: string) => console.log(`\n-- ${s} --`);

/** Build a grid from ASCII art. '#' is filled. */
function grid(rows: string[]) {
  const h = rows.length;
  const w = rows[0].length;
  return { w, h, filled: (x: number, y: number) => rows[y]?.[x] === '#' };
}

// ---------------------------------------------------------------------------

section('geometry helpers');
{
  const square: Pt[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
  check('signed area magnitude', Math.abs(signedArea(square)), 16);
  ok('reversing flips the sign', signedArea(square) * signedArea([...square].reverse()) < 0);
  ok('inside is inside', pointInPolygon([2, 2], square));
  ok('outside is outside', !pointInPolygon([5, 2], square));
  ok('far outside is outside', !pointInPolygon([-1, -1], square));
}

section('simplification');
{
  // A dead-straight staircase-free line: every interior point is redundant.
  const line: Pt[] = Array.from({ length: 20 }, (_, i) => [i, 0] as Pt);
  check('a straight run collapses to its ends', simplify(line, 0.5).length, 2);

  // A pronounced corner must survive.
  const corner: Pt[] = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
  check('corners are kept', simplify(corner, 0.5), [[0, 0], [10, 0], [10, 10]]);

  check('tiny inputs pass through', simplify([[0, 0], [1, 1]], 1), [[0, 0], [1, 1]]);
  check('zero tolerance is a no-op', simplify(corner, 0).length, corner.length);
}

section('closed-loop simplification is rotation invariant');
{
  // The whole reason simplifyClosed exists: plain RDP pins whichever point
  // tracing happened to start on, so the answer would depend on where the trace
  // began. Same loop, four starting points, one answer.
  const loop: Pt[] = [];
  for (let x = 0; x < 6; x++) loop.push([x, 0]);
  for (let y = 0; y < 6; y++) loop.push([6, y]);
  for (let x = 6; x > 0; x--) loop.push([x, 6]);
  for (let y = 6; y > 0; y--) loop.push([0, y]);

  const canonical = (pts: Pt[]) => JSON.stringify([...pts].map((p) => p.join(',')).sort());
  const results = [0, 5, 11, 17].map((k) =>
    canonical(simplifyClosed([...loop.slice(k), ...loop.slice(0, k)], 0.5)),
  );
  ok('all rotations agree', new Set(results).size === 1, results.join(' | '));
  check('and reduce to four corners', simplifyClosed(loop, 0.5).length, 4);
}

section('a solid square');
{
  const g = grid([
    '.....',
    '.###.',
    '.###.',
    '.###.',
    '.....',
  ]);
  const loops = traceLoops(g.filled, g.w, g.h);
  check('one boundary loop', loops.length, 1);

  const polys = traceToPolygons(g.filled, g.w, g.h, { normalize: false, tolerance: 0.1, minArea: 0 });
  check('one polygon', polys.length, 1);
  check('no holes', polys[0].holes.length, 0);
  check('simplifies to four corners', polys[0].outer.length, 4);
  check('correct area', Math.abs(signedArea(polys[0].outer)), 9);
}

section('a square with a hole — the letter O case');
{
  const g = grid([
    '.......',
    '.#####.',
    '.#...#.',
    '.#...#.',
    '.#...#.',
    '.#####.',
    '.......',
  ]);
  const polys = traceToPolygons(g.filled, g.w, g.h, { normalize: false, tolerance: 0.1, minArea: 0 });
  check('one polygon', polys.length, 1);
  check('with exactly one hole', polys[0].holes.length, 1);
  check('outer area', Math.abs(signedArea(polys[0].outer)), 25);
  check('hole area', Math.abs(signedArea(polys[0].holes[0])), 9);
  ok(
    'the hole winds opposite the outer',
    signedArea(polys[0].outer) * signedArea(polys[0].holes[0]) < 0,
  );
}

section('two separate shapes');
{
  const g = grid([
    '........',
    '.##..##.',
    '.##..##.',
    '........',
  ]);
  const polys = traceToPolygons(g.filled, g.w, g.h, { normalize: false, tolerance: 0.1, minArea: 0 });
  check('two polygons', polys.length, 2);
  check('neither has holes', polys.map((p) => p.holes.length), [0, 0]);
}

section('nested: an island inside a hole');
{
  // Ring, with a solid block floating in the middle of its hole.
  const g = grid([
    '.........',
    '.#######.',
    '.#.....#.',
    '.#.###.#.',
    '.#.###.#.',
    '.#.###.#.',
    '.#.....#.',
    '.#######.',
    '.........',
  ]);
  const polys = traceToPolygons(g.filled, g.w, g.h, { normalize: false, tolerance: 0.1, minArea: 0 });
  check('two polygons — the ring and the island', polys.length, 2);
  const withHole = polys.filter((p) => p.holes.length > 0);
  check('exactly one of them has a hole', withHole.length, 1);
  ok(
    'the hole belongs to the larger outline',
    Math.abs(signedArea(withHole[0].outer)) > Math.abs(signedArea(polys.find((p) => p !== withHole[0])!.outer)),
  );
}

section('holes nest into the tightest container');
{
  // Two independent rings side by side: each hole must find its own ring.
  const g = grid([
    '..........',
    '.###..###.',
    '.#.#..#.#.',
    '.###..###.',
    '..........',
  ]);
  const polys = traceToPolygons(g.filled, g.w, g.h, { normalize: false, tolerance: 0.1, minArea: 0 });
  check('two polygons', polys.length, 2);
  check('one hole each', polys.map((p) => p.holes.length), [1, 1]);
}

section('edge cases');
{
  const empty = traceToPolygons(() => false, 5, 5, { normalize: false, minArea: 0 });
  check('an empty grid yields nothing', empty.length, 0);

  // Filled right to the border — boundary cells must still emit edges.
  const full = traceToPolygons(() => true, 4, 4, { normalize: false, tolerance: 0.1, minArea: 0 });
  check('a fully filled grid is one polygon', full.length, 1);
  check('covering the whole grid', Math.abs(signedArea(full[0].outer)), 16);

  // Tolerance is held below one cell here so the check isolates minArea; at the
  // default tolerance of 1 a single-cell speck collapses on its own, which is
  // the intended behaviour but would confound this test.
  const speck = grid(['....', '.#..', '....']);
  const traceSpeck = (minArea: number) =>
    traceToPolygons(speck.filled, speck.w, speck.h, { normalize: false, tolerance: 0.1, minArea });
  check('specks are discarded by minArea', traceSpeck(4).length, 0);
  check('and kept when minArea allows', traceSpeck(0).length, 1);
  check(
    'at default tolerance a one-cell speck collapses anyway',
    traceToPolygons(speck.filled, speck.w, speck.h, { normalize: false, minArea: 0 }).length,
    0,
  );
}

section('normalization maps the grid to 0..1');
{
  const g = grid(['....', '.##.', '.##.', '....']);
  const polys = traceToPolygons(g.filled, g.w, g.h, { tolerance: 0.1, minArea: 0 });
  const xs = polys[0].outer.map((p) => p[0]);
  const ys = polys[0].outer.map((p) => p[1]);
  ok('x within 0..1', Math.min(...xs) >= 0 && Math.max(...xs) <= 1, `${Math.min(...xs)}..${Math.max(...xs)}`);
  ok('y within 0..1', Math.min(...ys) >= 0 && Math.max(...ys) <= 1, `${Math.min(...ys)}..${Math.max(...ys)}`);
  check('matches the 1..3 of 4 span', [Math.min(...xs), Math.max(...xs)], [0.25, 0.75]);
}

section('a disc traces cleanly');
{
  const N = 64;
  const filled = (x: number, y: number) => Math.hypot(x - N / 2, y - N / 2) < N / 3;
  const polys = traceToPolygons(filled, N, N, { normalize: false, tolerance: 0.6, minArea: 4 });
  check('one polygon', polys.length, 1);
  check('no holes', polys[0].holes.length, 0);

  const area = Math.abs(signedArea(polys[0].outer));
  const expected = Math.PI * (N / 3) ** 2;
  ok('area within 5% of a true circle', Math.abs(area - expected) / expected < 0.05, `${area.toFixed(0)} vs ${expected.toFixed(0)}`);
  ok('simplification actually reduced the point count', polys[0].outer.length < 100, `${polys[0].outer.length} points`);
}

section('groupLoops directly');
{
  // Convention: outers wind negative, holes positive. Assert that up front
  // rather than trusting the fixtures — getting it backwards silently turns
  // every outline into a discarded hole.
  const outerLoop: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const holeLoop: Pt[] = [[2, 2], [2, 8], [8, 8], [8, 2]];
  ok('fixture outer winds negative', signedArea(outerLoop) < 0, `${signedArea(outerLoop)}`);
  ok('fixture hole winds positive', signedArea(holeLoop) > 0, `${signedArea(holeLoop)}`);

  const polys = groupLoops([outerLoop, holeLoop], 0);
  check('one outer', polys.length, 1);
  check('one hole', polys[0].holes.length, 1);

  // A hole with no container is dropped rather than becoming a phantom outline.
  const orphan: Pt[] = [[100, 100], [100, 106], [106, 106], [106, 100]];
  ok('orphan winds like a hole', signedArea(orphan) > 0);
  check('an uncontained hole yields no polygon', groupLoops([orphan], 0).length, 0);
}

// ---------------------------------------------------------------------------

console.log();
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} trace checks passed.`);
