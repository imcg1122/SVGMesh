/**
 * PrusaSlicer / OrcaSlicer MMU segmentation codec.
 *
 * Encodes and decodes the per-triangle subdivision tree stored in the
 * `slic3rpe:mmu_segmentation` attribute (PrusaSlicer) or `paint_color`
 * (Bambu Studio / OrcaSlicer, which forked PrusaSlicer's TriangleSelector).
 *
 * Grammar, reading the hex string BACKWARDS, bits LSB-first within each nibble:
 *
 *   node := split:2 ( state:2 [ext:4 when state == 0b11, value = ext + 3]  -- leaf
 *                   | specialSide:2 node{split+1} )                       -- split
 *
 *   split 0 -> leaf        split 1 -> 2 children
 *   split 2 -> 3 children  split 3 -> 4 children
 *
 * States 0-2 encode directly (0x0, 0x4, 0x8). State >= 3 emits marker 0xC plus a
 * 4-bit extension nibble, so the maximum representable state is 18.
 *
 * VERIFIED 2026-08-09 against PrusaSlicer 2.9.6 output on a Prusa XL 5T profile:
 *   - Decoding a hand-painted file re-encodes byte-for-byte identically.
 *   - State N maps to extruder N. State 0 means "unpainted", which falls back to
 *     the volume's own extruder.
 *
 * Because state 1 equals extruder 1 and most objects default to extruder 1,
 * painting with state 1 is invisible against an unpainted background. That is
 * expected behaviour, not a bug.
 */

/** Maximum state the encoding can represent: 4-bit extension + 3. */
export const MAX_STATE = 18;

export interface Node {
  /** Extruder index. Meaningful only on leaves. 0 = unpainted. */
  state: number;
  /** Which edge a partial split favours. Meaningful only on split nodes. */
  specialSide: number;
  /** Empty for a leaf; 2, 3 or 4 entries for a split. */
  children: Node[];
}

export function leaf(state: number): Node {
  return { state, specialSide: 0, children: [] };
}

export function split(children: Node[], specialSide = 0): Node {
  return { state: 0, specialSide, children };
}

export function isLeaf(n: Node): boolean {
  return n.children.length === 0;
}

// ---------------------------------------------------------------------------
// Tree utilities
// ---------------------------------------------------------------------------

/** Collapse subtrees whose leaves all share one state. Large size win. */
export function prune(n: Node): Node {
  if (isLeaf(n)) return n;
  const children = n.children.map(prune);
  if (children.every(isLeaf)) {
    const first = children[0].state;
    if (children.every((c) => c.state === first)) return leaf(first);
  }
  return { ...n, children };
}

export function leafCount(n: Node): number {
  return isLeaf(n) ? 1 : n.children.reduce((a, c) => a + leafCount(c), 0);
}

export function maxDepth(n: Node): number {
  return isLeaf(n) ? 0 : 1 + Math.max(...n.children.map(maxDepth));
}

/** Every state referenced by the tree. Useful for building extruder lists. */
export function usedStates(n: Node, out = new Set<number>()): Set<number> {
  if (isLeaf(n)) out.add(n.state);
  else n.children.forEach((c) => usedStates(c, out));
  return out;
}

/**
 * Rewrite leaf states through a mapping. Needed whenever extruders are
 * renumbered — paint strings cannot be preserved verbatim across a remap.
 */
export function remapStates(n: Node, mapping: Map<number, number>): Node {
  if (isLeaf(n)) return leaf(mapping.get(n.state) ?? n.state);
  return { ...n, children: n.children.map((c) => remapStates(c, mapping)) };
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/** Serialize a tree. Returns '' for an unpainted leaf (omit the attribute). */
export function encode(root: Node): string {
  if (isLeaf(root) && root.state === 0) return '';
  const buf: number[] = [];
  encodeNode(root, buf);
  buf.reverse();
  return buf.map((n) => n.toString(16).toUpperCase()).join('');
}

function encodeNode(n: Node, buf: number[]): void {
  if (isLeaf(n)) {
    if (n.state < 0 || n.state > MAX_STATE) {
      throw new RangeError(`state ${n.state} outside 0..${MAX_STATE}`);
    }
    if (n.state < 3) {
      buf.push(n.state << 2);
    } else {
      buf.push(0xc); // extended-state marker
      buf.push(n.state - 3); // extension nibble
    }
    return;
  }

  const splitType = n.children.length - 1;
  if (splitType < 1 || splitType > 3) {
    throw new RangeError(`node has ${n.children.length} children; must be 2-4`);
  }
  buf.push((n.specialSide << 2) | splitType);
  for (const c of n.children) encodeNode(c, buf); // pre-order
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/** Parse a hex string back into a tree. Throws on malformed input. */
export function decode(s: string): Node {
  if (!s) return leaf(0);
  const r = { s, pos: s.length - 1 };
  const root = decodeNode(r);
  if (r.pos >= 0) {
    throw new Error(`trailing data: ${r.pos + 1} nibble(s) unconsumed in "${s}"`);
  }
  return root;
}

interface Reader {
  s: string;
  pos: number;
}

function nextNibble(r: Reader): number {
  if (r.pos < 0) throw new Error('ran off the start of the string; malformed input');
  const v = parseInt(r.s[r.pos], 16);
  if (Number.isNaN(v)) throw new Error(`non-hex character "${r.s[r.pos]}"`);
  r.pos -= 1;
  return v;
}

function decodeNode(r: Reader): Node {
  const nibble = nextNibble(r);
  const splitType = nibble & 0b11;
  const upper = nibble >> 2;

  if (splitType === 0) {
    let state = upper;
    if (state === 3) state = nextNibble(r) + 3; // extended
    return leaf(state);
  }

  const children: Node[] = [];
  for (let i = 0; i < splitType + 1; i++) children.push(decodeNode(r));
  return split(children, upper);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];
export type Tri = readonly [Vec3, Vec3, Vec3];

const mid = (a: Vec3, b: Vec3): Vec3 => [
  (a[0] + b[0]) * 0.5,
  (a[1] + b[1]) * 0.5,
  (a[2] + b[2]) * 0.5,
];

const centroid = (a: Vec3, b: Vec3, c: Vec3): Vec3 => [
  (a[0] + b[0] + c[0]) / 3,
  (a[1] + b[1] + c[1]) / 3,
  (a[2] + b[2] + c[2]) / 3,
];

/**
 * Split a triangle 4 ways in PrusaSlicer's child order.
 *
 *          v0
 *          /\
 *      t01/__\t20
 *        /\  /\
 *       /__\/__\
 *      v1  t12  v2
 *
 * Order: 0 = Center, 1 = Corner2, 2 = Corner1, 3 = Corner0.
 * Getting this order wrong puts colours in the wrong places.
 */
export function subdivide4(v0: Vec3, v1: Vec3, v2: Vec3): Tri[] {
  const t01 = mid(v0, v1);
  const t12 = mid(v1, v2);
  const t20 = mid(v2, v0);
  return [
    [t01, t12, t20],
    [t12, v2, t20],
    [t01, v1, t12],
    [v0, t01, t20],
  ];
}

export type Classifier = (p: Vec3) => number;

/**
 * Adaptively subdivide a triangle against a classifier.
 *
 * Samples the three corners plus the centroid. Corner-only sampling misses thin
 * features that pass through the middle of a triangle, which matters for the
 * hairline strokes common in icon SVGs.
 */
export function buildTree(
  v0: Vec3,
  v1: Vec3,
  v2: Vec3,
  classify: Classifier,
  maxDepthAllowed: number,
  depth = 0,
): Node {
  const samples = [classify(v0), classify(v1), classify(v2), classify(centroid(v0, v1, v2))];

  const first = samples[0];
  if (samples.every((s) => s === first)) return leaf(first);

  if (depth >= maxDepthAllowed) {
    // Out of budget: majority vote.
    const counts = new Map<number, number>();
    for (const s of samples) counts.set(s, (counts.get(s) ?? 0) + 1);
    let best = first;
    let bestN = 0;
    for (const [s, n] of counts) if (n > bestN) [best, bestN] = [s, n];
    return leaf(best);
  }

  const children = subdivide4(v0, v1, v2).map(([a, b, c]) =>
    buildTree(a, b, c, classify, maxDepthAllowed, depth + 1),
  );
  return prune(split(children));
}
