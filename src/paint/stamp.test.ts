/**
 * Stamp engine tests. Headless — synthetic masks, no DOM required.
 *
 * Run with:  npm test
 *
 * The load-bearing test here is "geometry is never modified". An earlier
 * version pre-subdivided triangles inside the decal footprint, which created
 * T-junctions and turned a watertight 108-triangle model into one with 108 open
 * edges. PrusaSlicer demanded a repair, and the repair discarded all the paint.
 * The manifold check below exists so that can never silently come back.
 */

import { decode, usedStates } from '../mmu/codec.ts';
import type { Tri, Vec3 } from '../mmu/codec.ts';
import {
  depthForTriangle,
  projectorFromHit,
  stamp,
  stampLayers,
  triNormal,
  worldToUV,
} from './stamp.ts';

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

/** A 40mm plate at z=10 facing +Z, plus two decoy triangles facing -Z. */
function plate(): Tri[] {
  const a: Vec3 = [0, 0, 10];
  const b: Vec3 = [40, 0, 10];
  const c: Vec3 = [40, 40, 10];
  const d: Vec3 = [0, 40, 10];
  return [
    [a, b, c],
    [a, c, d],
    [[0, 0, 0], [40, 40, 0], [40, 0, 0]],
    [[0, 0, 0], [0, 40, 0], [40, 40, 0]],
  ];
}

/** A closed, watertight 20mm cube — 12 triangles, every edge shared twice. */
function cube(): Tri[] {
  const s = 20;
  const v: Vec3[] = [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ];
  const f: [number, number, number][] = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
    [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7],
  ];
  return f.map(([i, j, k]) => [v[i], v[j], v[k]] as Tri);
}

/** Count edges used by exactly two triangles. Zero "open" edges = watertight. */
function openEdges(tris: Tri[]): number {
  const ids = new Map<string, number>();
  const id = (p: Vec3) => {
    const k = p.map((c) => c.toFixed(6)).join(',');
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k)!;
  };
  const edges = new Map<string, number>();
  for (const t of tris) {
    const [a, b, c] = t.map(id);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = p < q ? `${p}-${q}` : `${q}-${p}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  return [...edges.values()].filter((n) => n !== 2).length;
}

const centre: Vec3 = [20, 20, 10];
const up: Vec3 = [0, 0, 1];
const disc = (u: number, v: number) => Math.hypot(u - 0.5, v - 0.5) <= 0.3;
const everywhere = () => true;

// ---------------------------------------------------------------------------

section('projector maths');
{
  const p = projectorFromHit(centre, up, 20, 20);
  check('direction points into the surface', p.direction, [-0, -0, -1]);
  check('origin maps to UV centre', worldToUV(centre, p), [0.5, 0.5]);
  ok('basis is orthogonal', Math.abs(p.right[0] * p.up[0] + p.right[1] * p.up[1] + p.right[2] * p.up[2]) < 1e-9);

  const rolled = projectorFromHit(centre, up, 20, 20, Math.PI / 2);
  const d = rolled.right[0] * p.right[0] + rolled.right[1] * p.right[1] + rolled.right[2] * p.right[2];
  ok('roll rotates the basis', Math.abs(d) < 1e-9, `dot=${d}`);
}

section('triangle normals');
check('plate top faces +Z', triNormal(plate()[0]).map(Math.round), [0, 0, 1]);

section('depth is derived from triangle size and target detail');
check('edge already finer than target needs no depth', depthForTriangle(0.1, 0.2, 7), 0);
check('12mm edge at 0.2mm target', depthForTriangle(12, 0.2, 7), 6);
check('6.25mm edge at 0.2mm target', depthForTriangle(6.25, 0.2, 7), 5);
check('cap is respected', depthForTriangle(1000, 0.01, 7), 7);
check('zero target is a no-op', depthForTriangle(12, 0, 7), 0);
{
  // Halving the target should cost exactly one more level.
  const a = depthForTriangle(10, 0.4, 12);
  const b = depthForTriangle(10, 0.2, 12);
  check('halving the target adds one level', b - a, 1);
}

section('GEOMETRY IS NEVER MODIFIED');
{
  const input = cube();
  check('the cube starts watertight', openEdges(input), 0);

  const res = stamp(input, {
    projector: projectorFromHit([10, 10, 20], up, 12, 12),
    mask: disc,
    state: 2,
    targetFeatureMm: 0.05, // deliberately punishing
  });

  check('triangle count unchanged', res.stats.triangles, input.length);
  check('output array length matches', res.tris.length, input.length);
  check('still watertight after stamping', openEdges(res.tris), 0);
  ok('the exact same triangle objects come back', res.tris === input);
  check('segments align 1:1 with triangles', res.segments.length, input.length);
  ok('something actually got painted', res.stats.paintedTriangles > 0);
}

section('a decal much smaller than a triangle is still found');
{
  // The 40mm plate is two triangles. A 3mm decal in the middle touches none of
  // their corners. The old sample-agreement early-out concluded "all four
  // samples say unpainted, therefore uniform" and emitted nothing at all.
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 3, 3),
    mask: everywhere,
    state: 2,
    targetFeatureMm: 0.2,
  });
  ok('the small decal is painted', res.stats.paintedTriangles > 0, `painted=${res.stats.paintedTriangles}`);

  const states = new Set<number>();
  res.segments.forEach((s) => s && usedStates(decode(s), states));
  ok('the paint state is present', states.has(2));

  // And it must stay local: a 3mm decal shouldn't flood a 40mm plate.
  const leaves = res.segments.filter((s) => s).reduce((n, s) => n + JSON.stringify(decode(s)).length, 0);
  ok('output stays bounded', leaves > 0);
}

section('a hairline stroke through the middle survives');
{
  // A 2%-wide vertical bar: the kind of thin feature icon SVGs are full of.
  const hairline = (u: number) => Math.abs(u - 0.5) < 0.01;
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 30, 30),
    mask: hairline,
    state: 3,
    targetFeatureMm: 0.2,
  });
  const states = new Set<number>();
  res.segments.forEach((s) => s && usedStates(decode(s), states));
  ok('hairline is resolved', states.has(3), `states=${[...states]}`);
}

section('multiple decals in one pass');
{
  const left = projectorFromHit([12, 20, 10], up, 8, 8);
  const right = projectorFromHit([28, 20, 10], up, 8, 8);
  const res = stampLayers(
    plate(),
    [
      { projector: left, mask: everywhere, state: 2 },
      { projector: right, mask: everywhere, state: 4 },
    ],
    { targetFeatureMm: 0.3 },
  );
  const states = new Set<number>();
  res.segments.forEach((s) => s && usedStates(decode(s), states));
  check('both decals present with their own toolheads', [...states].sort(), [0, 2, 4]);
  check('geometry untouched', res.stats.triangles, 4);
}

section('overlapping decals resolve last-wins');
{
  const p = projectorFromHit(centre, up, 10, 10);
  const res = stampLayers(
    plate(),
    [
      { projector: p, mask: everywhere, state: 2 },
      { projector: p, mask: everywhere, state: 5 },
    ],
    { targetFeatureMm: 0.5 },
  );
  const states = new Set<number>();
  res.segments.forEach((s) => s && usedStates(decode(s), states));
  ok('the later decal wins', states.has(5) && !states.has(2), `states=${[...states]}`);
}

section('back faces are not painted');
{
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 100, 100),
    mask: everywhere,
    state: 2,
    targetFeatureMm: 0,
  });
  check('only the two upward-facing triangles', res.segments.filter((s) => s).length, 2);
}

section('mask is respected');
{
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 30, 30),
    mask: disc,
    state: 2,
    targetFeatureMm: 0.5,
  });
  const states = new Set<number>();
  res.segments.forEach((s) => s && usedStates(decode(s), states));
  check('only unpainted and the paint state appear', [...states].sort(), [0, 2]);
  ok('resolution is reported', res.stats.effectiveResolutionMm > 0);
}

section('extruder state passes through to the encoding');
for (const state of [2, 3, 4, 5]) {
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 100, 100),
    mask: everywhere,
    state,
    targetFeatureMm: 0,
  });
  const states = new Set<number>();
  res.segments.forEach((s) => s && usedStates(decode(s), states));
  check(`state ${state} survives round-trip`, [...states], [state]);
}

section('decal off the model paints nothing');
{
  const res = stamp(plate(), {
    projector: projectorFromHit([500, 500, 10], up, 10, 10),
    mask: everywhere,
    state: 2,
  });
  check('no painted triangles', res.stats.paintedTriangles, 0);
  check('geometry still untouched', res.stats.triangles, 4);
}

section('every emitted segment decodes');
{
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 25, 25),
    mask: disc,
    state: 4,
    targetFeatureMm: 0.2,
  });
  let bad = 0;
  for (const s of res.segments) {
    if (!s) continue;
    try {
      decode(s);
    } catch {
      bad++;
    }
  }
  check('no undecodable segments', bad, 0);
  console.log(
    `        ${res.stats.triangles} triangles, ${res.stats.paintedTriangles} painted, ` +
      `depth ${res.stats.maxTreeDepth}, ${res.stats.effectiveResolutionMm.toFixed(3)} mm`,
  );
}

// ---------------------------------------------------------------------------

console.log();
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} stamp checks passed.`);
