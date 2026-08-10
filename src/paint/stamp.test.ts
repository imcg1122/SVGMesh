/**
 * Stamp engine tests. Headless — uses a synthetic mask, no DOM required.
 *
 * Run with:  npm test
 */

import { decode, usedStates } from '../mmu/codec.ts';
import type { Tri, Vec3 } from '../mmu/codec.ts';
import { projectorFromHit, stamp, triNormal, worldToUV } from './stamp.ts';

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

/** A 40mm plate at z=10, two triangles, facing +Z. Plus a decoy facing -Z. */
function plate(): Tri[] {
  const a: Vec3 = [0, 0, 10];
  const b: Vec3 = [40, 0, 10];
  const c: Vec3 = [40, 40, 10];
  const d: Vec3 = [0, 40, 10];
  const under: Tri[] = [
    [[0, 0, 0], [40, 40, 0], [40, 0, 0]],
    [[0, 0, 0], [0, 40, 0], [40, 40, 0]],
  ];
  return [[a, b, c], [a, c, d], ...under];
}

const centre: Vec3 = [20, 20, 10];
const up: Vec3 = [0, 0, 1];

// A centred disc of radius 0.3 in UV space.
const disc = (u: number, v: number) => Math.hypot(u - 0.5, v - 0.5) <= 0.3;
const everywhere = () => true;

// ---------------------------------------------------------------------------

section('projector maths');
{
  const p = projectorFromHit(centre, up, 20, 20);
  check('direction points into the surface', p.direction, [-0, -0, -1]);
  const [u, v] = worldToUV(centre, p);
  check('origin maps to UV centre', [u, v], [0.5, 0.5]);
  ok('basis is orthogonal', Math.abs(p.right[0] * p.up[0] + p.right[1] * p.up[1] + p.right[2] * p.up[2]) < 1e-9);

  const rolled = projectorFromHit(centre, up, 20, 20, Math.PI / 2);
  const dotRight = rolled.right[0] * p.right[0] + rolled.right[1] * p.right[1] + rolled.right[2] * p.right[2];
  ok('roll rotates the basis', Math.abs(dotRight) < 1e-9, `dot=${dotRight}`);
}

section('triangle normals');
check('plate top faces +Z', triNormal(plate()[0]).map(Math.round), [0, 0, 1]);

section('back faces are not painted');
{
  // Footprint deliberately larger than the plate so every sample lands inside
  // it; this isolates the back-face test from any edge behaviour.
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 100, 100),
    mask: everywhere,
    state: 2,
    targetEdgeMm: 0,
    maxDepth: 0,
  });
  // The two downward-facing triangles sit inside the footprint but face away,
  // so they must come through untouched.
  const painted = res.segments.filter((s) => s).length;
  check('only the two top triangles are painted', painted, 2);
  check('nothing was subdivided', res.stats.outputTriangles, 4);
}

section('mask is respected');
{
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 30, 30),
    mask: disc,
    state: 2,
    targetEdgeMm: 2,
    maxDepth: 4,
  });
  const states = new Set<number>();
  res.segments.forEach((s) => s && usedStates(decode(s), states));
  check('only state 0 and the paint state appear', [...states].sort(), [0, 2]);
  ok('some triangles are painted', res.stats.paintedTriangles > 0);
  ok(
    'not everything is painted (the disc has an outside)',
    res.stats.paintedTriangles < res.stats.outputTriangles,
    `${res.stats.paintedTriangles}/${res.stats.outputTriangles}`,
  );
}

section('pre-subdivision honours the target edge length');
{
  const coarse = stamp(plate(), {
    projector: projectorFromHit(centre, up, 30, 30),
    mask: disc,
    state: 2,
    targetEdgeMm: 0,
    maxDepth: 2,
  });
  const fine = stamp(plate(), {
    projector: projectorFromHit(centre, up, 30, 30),
    mask: disc,
    state: 2,
    targetEdgeMm: 1,
    maxDepth: 2,
  });
  ok(
    'smaller target edge produces more triangles',
    fine.stats.outputTriangles > coarse.stats.outputTriangles,
    `${fine.stats.outputTriangles} vs ${coarse.stats.outputTriangles}`,
  );
  check('back faces still untouched', coarse.stats.outputTriangles - 2, 2);
}

section('extruder state passes through to the encoding');
for (const state of [2, 3, 4, 5]) {
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 100, 100),
    mask: everywhere,
    state,
    targetEdgeMm: 0,
    maxDepth: 0,
  });
  const states = new Set<number>();
  res.segments.forEach((s) => s && usedStates(decode(s), states));
  check(`state ${state} survives round-trip`, [...states], [state]);
}

section('decal outside the model paints nothing');
{
  const res = stamp(plate(), {
    projector: projectorFromHit([500, 500, 10], up, 10, 10),
    mask: everywhere,
    state: 2,
    targetEdgeMm: 0,
    maxDepth: 2,
  });
  check('no painted triangles', res.stats.paintedTriangles, 0);
  check('geometry untouched', res.stats.outputTriangles, 4);
}

section('every emitted segment is valid and decodes');
{
  const res = stamp(plate(), {
    projector: projectorFromHit(centre, up, 25, 25),
    mask: disc,
    state: 4,
    targetEdgeMm: 1.5,
    maxDepth: 5,
  });
  check('segments align 1:1 with triangles', res.segments.length, res.tris.length);
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
    `        ${res.stats.inputTriangles} in -> ${res.stats.outputTriangles} out, ` +
      `${res.stats.paintedTriangles} painted`,
  );
}

// ---------------------------------------------------------------------------

console.log();
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} stamp checks passed.`);
