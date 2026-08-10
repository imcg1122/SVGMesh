/** Decal store and undo history. Headless. */

import { DecalStore } from './decals.ts';
import type { Vec3 } from '../mmu/codec.ts';

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

const P: Vec3 = [0, 0, 0];
const N: Vec3 = [0, 0, 1];

function store() {
  const s = new DecalStore();
  const a = s.addAsset({ name: 'icon.svg', svgText: '<svg/>', mask: () => true, aspect: 1 });
  return { s, a };
}
const place = (s: DecalStore, assetId: string, state = 2) =>
  s.add({ assetId, point: P, normal: N, widthMm: 20, rollDeg: 0, state });

// ---------------------------------------------------------------------------

section('placing and selecting');
{
  const { s, a } = store();
  const d1 = place(s, a.id);
  const d2 = place(s, a.id, 3);
  check('two decals placed', s.decals.length, 2);
  check('newest is selected', s.selectedId, d2.id);
  check('ids are distinct', d1.id === d2.id, false);
  check('asset lookup works', s.assetFor(d2)?.name, 'icon.svg');
}

section('removing');
{
  const { s, a } = store();
  const d1 = place(s, a.id);
  const d2 = place(s, a.id);
  s.remove(d2.id);
  check('one left', s.decals.length, 1);
  check('selection falls back to a live decal', s.selectedId, d1.id);
  s.remove(d1.id);
  check('empty', s.decals.length, 0);
  check('selection cleared', s.selectedId, null);
}

section('undo and redo');
{
  const { s, a } = store();
  check('nothing to undo at the start', s.canUndo, false);

  place(s, a.id);
  place(s, a.id);
  check('two placed', s.decals.length, 2);

  s.undo();
  check('undo removes the second', s.decals.length, 1);
  s.undo();
  check('undo removes the first', s.decals.length, 0);
  check('exhausted', s.canUndo, false);
  check('undo on empty history is a no-op', s.undo(), false);

  s.redo();
  check('redo restores one', s.decals.length, 1);
  s.redo();
  check('redo restores both', s.decals.length, 2);
  check('redo exhausted', s.canRedo, false);
}

section('editing is undoable');
{
  const { s, a } = store();
  const d = place(s, a.id);
  s.update(d.id, { widthMm: 50 });
  check('edit applied', s.selected?.widthMm, 50);
  s.undo();
  check('edit reverted', s.selected?.widthMm, 20);
}

section('gestures coalesce into one undo step');
{
  const { s, a } = store();
  const d = place(s, a.id);

  // Simulate a drag: one commit up front, then many coalesced updates.
  s.beginGesture();
  for (let x = 1; x <= 10; x++) s.update(d.id, { point: [x, 0, 0] }, true);
  check('drag applied', s.selected?.point, [10, 0, 0]);

  s.undo();
  check('one undo reverts the whole drag', s.selected?.point, [0, 0, 0]);
  ok('the decal still exists', s.decals.length === 1);
}

section('a new action clears the redo stack');
{
  const { s, a } = store();
  place(s, a.id);
  s.undo();
  check('redo available after undo', s.canRedo, true);
  place(s, a.id);
  check('new action drops the redo branch', s.canRedo, false);
}

section('history is bounded');
{
  const { s, a } = store();
  const d = place(s, a.id);
  for (let i = 0; i < 250; i++) s.update(d.id, { widthMm: i });
  let steps = 0;
  while (s.undo()) steps++;
  ok('history capped near 100 entries', steps <= 100, `steps=${steps}`);
}

// ---------------------------------------------------------------------------

console.log();
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} decal store checks passed.`);
