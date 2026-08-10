/**
 * Codec regression tests.
 *
 * Run with:  npm test        (node --experimental-strip-types, no deps needed)
 *
 * The most valuable cases here are the REAL_WORLD fixtures: raw
 * mmu_segmentation strings lifted from a file hand-painted in PrusaSlicer 2.9.6
 * on a Prusa XL 5T profile. If a future PrusaSlicer changes the format, these
 * break and we find out immediately.
 */

import {
  MAX_STATE,
  decode,
  encode,
  isLeaf,
  leaf,
  leafCount,
  prune,
  remapStates,
  split,
  usedStates,
} from './codec.ts';

let failures = 0;
let checks = 0;

function check(name: string, got: unknown, want: unknown): void {
  checks++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) return;
  failures++;
  console.error(`  FAIL  ${name}\n          got:  ${g}\n          want: ${w}`);
}

function throws(name: string, fn: () => unknown): void {
  checks++;
  try {
    fn();
    failures++;
    console.error(`  FAIL  ${name} (expected a throw, got none)`);
  } catch {
    /* expected */
  }
}

const section = (s: string) => console.log(`\n-- ${s} --`);

// ---------------------------------------------------------------------------

section('documented reference example');
// Root 4-way split, children [state 0, 1, 2, 1] -> "48403"
const ref = split([leaf(0), leaf(1), leaf(2), leaf(1)]);
check('encode reference tree', encode(ref), '48403');
check('decode child states', decode('48403').children.map((c) => c.state), [0, 1, 2, 1]);
check('decode root is a split', isLeaf(decode('48403')), false);

section('single leaf states');
check('state 0 is omitted', encode(leaf(0)), '');
check('state 1', encode(leaf(1)), '4');
check('state 2', encode(leaf(2)), '8');
check('state 3 (extended)', encode(leaf(3)), '0C');
check('state 4 (extended)', encode(leaf(4)), '1C');
check('state 5 (extended)', encode(leaf(5)), '2C');
check('state 18 (max)', decode(encode(leaf(MAX_STATE))).state, MAX_STATE);
for (let s = 1; s <= MAX_STATE; s++) {
  check(`round-trip state ${s}`, decode(encode(leaf(s))).state, s);
}
throws('state above max rejected', () => encode(leaf(MAX_STATE + 1)));
throws('negative state rejected', () => encode(leaf(-1)));

section('XL five-toolhead coverage');
const xl = split([leaf(2), leaf(3), leaf(4), leaf(5)]);
check(
  'all extended extruders survive',
  decode(encode(xl)).children.map((c) => c.state),
  [2, 3, 4, 5],
);

section('nested subdivision');
const nested = split([
  split([leaf(1), leaf(0), leaf(4), leaf(2)]),
  leaf(3),
  split([leaf(5), leaf(0), leaf(1), leaf(1)], 2),
  leaf(0),
]);
const nestedBack = decode(encode(nested));
check('inner branch 0', nestedBack.children[0].children.map((c) => c.state), [1, 0, 4, 2]);
check('inner branch 2', nestedBack.children[2].children.map((c) => c.state), [5, 0, 1, 1]);
check('specialSide preserved', nestedBack.children[2].specialSide, 2);

section('partial splits');
check('2-way round-trip', decode(encode(split([leaf(2), leaf(4)], 1))).children.map((c) => c.state), [2, 4]);
check('2-way specialSide', decode(encode(split([leaf(2), leaf(4)], 1))).specialSide, 1);
check(
  '3-way round-trip',
  decode(encode(split([leaf(1), leaf(3), leaf(0)], 2))).children.map((c) => c.state),
  [1, 3, 0],
);

section('pruning');
check('uniform subtree collapses', isLeaf(prune(split([leaf(2), leaf(2), leaf(2), leaf(2)]))), true);
check('collapsed keeps state', prune(split([leaf(2), leaf(2), leaf(2), leaf(2)])).state, 2);
check('mixed subtree survives', isLeaf(prune(split([leaf(2), leaf(2), leaf(1), leaf(2)]))), false);

section('state remapping');
const remapped = remapStates(split([leaf(1), leaf(2), leaf(3), leaf(0)]), new Map([[1, 5], [2, 4]]));
check('states remapped, others untouched', remapped.children.map((c) => c.state), [5, 4, 3, 0]);
check('usedStates', [...usedStates(split([leaf(1), leaf(2), leaf(2), leaf(0)]))].sort(), [0, 1, 2]);

section('malformed input rejected');
throws('truncated', () => decode('3'));
throws('trailing data', () => decode('444'));
throws('non-hex', () => decode('4Z403'));

section('real PrusaSlicer 2.9.6 output (XL 5T, hand-painted)');
// Verbatim mmu_segmentation strings from "painted blob test.3mf".
const REAL_WORLD = [
  '80086883000088060330003',
  '88008688388300008038088802008A3300803080008288806333',
  '0000882888308010A0003080818056003303',
  '8808868838830088288838883800A800A808823880A800A8088238833',
  '00800688002088A3003003',
  '00008030300030800380880833888088383088000308088333003',
  '88088688388300000805A888300080102033800A0800823080088288806333',
  '8008828883888388880A8838833',
  '0088880A830800A00330800800603800A888380882888333',
  '00800388000388083388000803008033888088383300800300303',
  '008888088388383000880830388083000300800300333',
  '08010608800A30808081805A80801085233008000085A300308883888300080818056038008820801085A8006333',
  '88008688388300008880638088802088A3300803080088288806333',
  '08081805688002088A300380880801085683088A0801085A080023080818052000333',
  '008806880203888388020003000300088A0030033',
  '0088802008A300388888020088630088060380008568833880886000085203833',
  '088600882800A3008088A800630080060330008883880830800330008003033',
  '0080300080108520380888330800808180560308081805A8088238000852888333',
  '0000088200085A0300303',
  '8000856883008883008000852330000008A03088A088A080810230800600330008806003033',
  '8800882880A3000882088A80063008006033883',
  '8088600882800A3000882088A8081063008006033883',
  '88880028838388000803088608800A338880886883833',
  '00008003003003003',
  '88088388300008038088833008030808883330003',
  '88808838380888083008038088333880003000300038880830800888380883333',
  '00800388838883003',
  '0800388083080003300030003',
  '00880003080033003888808830800803383888000803008033833',
  '00088838883880003080883308003808000333003',
];

let allStates = new Set<number>();
let totalLeaves = 0;
REAL_WORLD.forEach((s, i) => {
  const tree = decode(s);
  check(`fixture ${i} re-encodes byte-for-byte`, encode(tree), s);
  usedStates(tree, allStates);
  totalLeaves += leafCount(tree);
});
// Ian painted this file entirely with toolhead 2, so state 2 is the only paint.
check('fixture states are exactly {0, 2}', [...allStates].sort(), [0, 2]);
console.log(`        ${REAL_WORLD.length} fixtures, ${totalLeaves} leaves total`);

// ---------------------------------------------------------------------------

console.log();
if (failures > 0) {
  console.error(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`All ${checks} codec checks passed.`);
