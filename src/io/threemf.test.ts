/**
 * 3MF writer tests. Headless — fflate works in Node, and `downloadBlob` (the
 * only DOM-touching export) is never called here.
 *
 * The volume span arithmetic is the part worth guarding: PrusaSlicer carves one
 * merged mesh into parts by triangle index range, so an off-by-one in
 * firstid/lastid silently assigns the wrong toolhead to the wrong geometry.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { build3mf, type Volume } from './threemf.ts';
import type { Tri, Vec3 } from '../mmu/codec.ts';

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

/** Axis-aligned box as 12 triangles, watertight. */
function box(ox: number, oy: number, oz: number, s: number): Tri[] {
  const v: Vec3[] = [
    [ox, oy, oz], [ox + s, oy, oz], [ox + s, oy + s, oz], [ox, oy + s, oz],
    [ox, oy, oz + s], [ox + s, oy, oz + s], [ox + s, oy + s, oz + s], [ox, oy + s, oz + s],
  ];
  const f: [number, number, number][] = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6],
    [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7],
  ];
  return f.map(([i, j, k]) => [v[i], v[j], v[k]] as Tri);
}

function read(data: Uint8Array) {
  const files = unzipSync(data);
  return {
    names: Object.keys(files).sort(),
    model: strFromU8(files['3D/3dmodel.model']),
    config: strFromU8(files['Metadata/Slic3r_PE_model.config']),
  };
}

const spans = (config: string) =>
  [...config.matchAll(/firstid="(\d+)" lastid="(\d+)"/g)].map((m) => [+m[1], +m[2]]);
const extruders = (config: string) =>
  [...config.matchAll(/key="extruder" value="(\d+)"/g)].map((m) => +m[1]);

// ---------------------------------------------------------------------------

section('package structure');
{
  const { names, model } = read(build3mf({ volumes: [{ name: 'm', tris: box(0, 0, 0, 10), extruder: 1 }] }));
  check('required entries', names, [
    '3D/3dmodel.model',
    'Metadata/Slic3r_PE_model.config',
    '[Content_Types].xml',
    '_rels/.rels',
  ]);
  ok('declares the slic3rpe namespace', model.includes('xmlns:slic3rpe'));
  ok('declares the painting version', model.includes('MmPaintingVersion'));
  ok('has a build item', model.includes('<item objectid="1"'));
}

section('single volume');
{
  const { model, config } = read(build3mf({ volumes: [{ name: 'm', tris: box(0, 0, 0, 10), extruder: 3 }] }));
  check('12 triangles', (model.match(/<triangle /g) ?? []).length, 12);
  check('8 welded vertices', (model.match(/<vertex /g) ?? []).length, 8);
  check('one span covering everything', spans(config), [[0, 11]]);
  check('extruder carried through', extruders(config), [3]);
}

section('multiple volumes get correct index spans');
{
  const volumes: Volume[] = [
    { name: 'model', tris: box(0, 0, 0, 20), extruder: 1 },
    { name: 'decal A', tris: box(2, 2, 19, 3), extruder: 2 },
    { name: 'decal B', tris: box(8, 8, 19, 3), extruder: 5 },
  ];
  const { model, config } = read(build3mf({ volumes }));

  check('36 triangles total', (model.match(/<triangle /g) ?? []).length, 36);
  check('spans are contiguous and non-overlapping', spans(config), [
    [0, 11],
    [12, 23],
    [24, 35],
  ]);
  check('each volume keeps its toolhead', extruders(config), [1, 2, 5]);
  ok('volume names are preserved', config.includes('value="decal A"') && config.includes('value="decal B"'));

  // Spans must exactly tile the triangle list, or PrusaSlicer assigns the
  // wrong toolhead to the wrong geometry.
  const s = spans(config);
  check('first span starts at 0', s[0][0], 0);
  check('last span ends at the final triangle', s.at(-1)![1], 35);
  for (let i = 1; i < s.length; i++) {
    check(`span ${i} follows span ${i - 1}`, s[i][0], s[i - 1][1] + 1);
  }
}

section('empty volumes are skipped, not mis-indexed');
{
  const { config } = read(
    build3mf({
      volumes: [
        { name: 'model', tris: box(0, 0, 0, 10), extruder: 1 },
        { name: 'empty', tris: [], extruder: 4 },
        { name: 'decal', tris: box(1, 1, 9, 2), extruder: 2 },
      ],
    }),
  );
  check('only two spans emitted', spans(config).length, 2);
  check('spans stay contiguous', spans(config), [[0, 11], [12, 23]]);
  check('the empty volume contributes no extruder', extruders(config), [1, 2]);
}

section('degenerate triangles are dropped');
{
  // A triangle whose corners weld together has no area, but it does make the
  // mesh report open edges — which makes PrusaSlicer demand a repair, and the
  // repair rebuilds the mesh and destroys the paint. Curve seams produce these
  // routinely, so the writer must never emit one.
  const p: Vec3 = [0, 0, 0];
  const solid = box(0, 0, 0, 10);
  const withJunk: Tri[] = [
    solid[0],
    [p, p, [1, 0, 0]], // two corners identical
    solid[1],
    [[2, 0, 0], [2, 0, 0], [2, 0, 0]], // all three identical
    ...solid.slice(2),
  ];

  const { model, config } = read(build3mf({ volumes: [{ name: 'm', tris: withJunk, extruder: 1 }] }));
  check('only the real triangles survive', (model.match(/<triangle /g) ?? []).length, 12);
  check('the span covers what was actually written', spans(config), [[0, 11]]);
}

section('dropping degenerates keeps paint aligned');
{
  const solid = box(0, 0, 0, 10);
  const tris: Tri[] = [solid[0], [[0, 0, 0], [0, 0, 0], [1, 0, 0]], solid[1]];
  const segments = ['4', '48403', '8']; // the middle one belongs to the junk triangle
  const { model } = read(build3mf({ volumes: [{ name: 'm', tris, extruder: 1, segments }] }));
  const painted = [...model.matchAll(/mmu_segmentation="([^"]+)"/g)].map((m) => m[1]);
  check('surviving triangles keep their own paint', painted, ['4', '8']);
}

section('a volume of nothing but degenerates gets no span');
{
  const { config } = read(
    build3mf({
      volumes: [
        { name: 'model', tris: box(0, 0, 0, 10), extruder: 1 },
        { name: 'junk', tris: [[[1, 1, 1], [1, 1, 1], [1, 1, 1]]], extruder: 3 },
        { name: 'decal', tris: box(1, 1, 9, 2), extruder: 2 },
      ],
    }),
  );
  check('two spans, still contiguous', spans(config), [[0, 11], [12, 23]]);
  check('the junk volume contributes no extruder', extruders(config), [1, 2]);
}

section('paint segments ride along on the right triangles');
{
  const tris = box(0, 0, 0, 10);
  const segments = tris.map((_, i) => (i === 5 ? '48403' : ''));
  const { model } = read(build3mf({ volumes: [{ name: 'm', tris, extruder: 1, segments }] }));
  const painted = [...model.matchAll(/<triangle [^>]*mmu_segmentation="([^"]+)"/g)].map((m) => m[1]);
  check('exactly one painted triangle', painted, ['48403']);
  ok('unpainted triangles carry no attribute', (model.match(/mmu_segmentation/g) ?? []).length === 1);
}

section('vertices are welded across volumes');
{
  // Two boxes sharing a face: coincident corners must collapse to one vertex.
  const { model } = read(
    build3mf({
      volumes: [
        { name: 'a', tris: box(0, 0, 0, 10), extruder: 1 },
        { name: 'b', tris: box(0, 0, 0, 10), extruder: 2 },
      ],
    }),
  );
  check('identical geometry welds to 8 vertices', (model.match(/<vertex /g) ?? []).length, 8);
  check('but both volumes keep their triangles', (model.match(/<triangle /g) ?? []).length, 24);
}

section('bad input is rejected');
{
  let threw = false;
  try {
    build3mf({ volumes: [] });
  } catch {
    threw = true;
  }
  ok('no volumes throws', threw);
}

section('XML escaping');
{
  const { config } = read(
    build3mf({ volumes: [{ name: 'a & b <c>', tris: box(0, 0, 0, 1), extruder: 1 }], objectName: '"quoted"' }),
  );
  ok('ampersands and brackets escaped', config.includes('a &amp; b &lt;c&gt;'));
  ok('quotes escaped', config.includes('&quot;quoted&quot;'));
  ok('no raw unescaped name leaked', !config.includes('value="a & b'));
}

// ---------------------------------------------------------------------------

console.log();
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} 3MF writer checks passed.`);
