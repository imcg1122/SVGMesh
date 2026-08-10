/**
 * The stamp engine: project an SVG mask onto mesh triangles and emit MMU paint.
 *
 * THE MESH IS NEVER MODIFIED. This is the central design rule and it is not
 * negotiable.
 *
 * PrusaSlicer's segmentation quadtree is *virtual*: each triangle carries a
 * subdivision tree that the slicer applies at slice time. The geometry itself
 * stays exactly as it was. That is the entire point of painting rather than
 * embossing.
 *
 * An earlier version pre-subdivided the mesh inside the decal footprint,
 * thinking it improved edge quality. It did not — it produced T-junctions,
 * because a subdivided triangle introduces midpoint vertices that its
 * un-subdivided neighbours know nothing about. Measured on a 108-triangle
 * hexagon token: 0 open edges before, 108 after. PrusaSlicer then demanded a
 * repair, and repairing rebuilt the mesh and discarded all the paint.
 *
 * So fidelity is controlled by ONE lever: how deep the virtual tree goes,
 * expressed as a target feature size in millimetres. Depth is chosen per
 * triangle from its own size, which gives uniform real-world resolution
 * whether the mesh is coarse or dense.
 *
 * Calibration note: a 0.4mm nozzle cannot render detail finer than roughly
 * 0.2mm no matter what the file says. Targets below that cost file size and
 * time and buy nothing. For reference, PrusaSlicer's own brush produces trees
 * 4-5 deep, resolving about 0.195mm on the 6.25mm triangles it was painting.
 */

import { buildTree, encode, prune } from '../mmu/codec.ts';
import type { Tri, Vec3 } from '../mmu/codec.ts';

// --- tiny vector helpers ---------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.sqrt(dot(a, a));

export function normalize(a: Vec3): Vec3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function triNormal(t: Tri): Vec3 {
  return normalize(cross(sub(t[1], t[0]), sub(t[2], t[0])));
}

// --- projector -------------------------------------------------------------

export interface PlanarProjector {
  /** Point on the surface the decal is centred on. */
  origin: Vec3;
  /** Unit direction the decal is projected ALONG (into the surface). */
  direction: Vec3;
  /** Unit in-plane axis mapped to the decal's +U. */
  right: Vec3;
  /** Unit in-plane axis mapped to the decal's +V (up on screen). */
  up: Vec3;
  /** Decal footprint in millimetres. */
  width: number;
  height: number;
}

/** Build a projector from a surface hit point and normal, with a roll angle. */
export function projectorFromHit(
  point: Vec3,
  surfaceNormal: Vec3,
  widthMm: number,
  heightMm: number,
  rollRad = 0,
): PlanarProjector {
  const n = normalize(surfaceNormal);
  // Any vector not parallel to n gives a stable starting tangent.
  const seed: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let right = normalize(cross(seed, n));
  let up = normalize(cross(n, right));
  if (rollRad !== 0) {
    const c = Math.cos(rollRad);
    const s = Math.sin(rollRad);
    const r2: Vec3 = [
      right[0] * c + up[0] * s,
      right[1] * c + up[1] * s,
      right[2] * c + up[2] * s,
    ];
    const u2: Vec3 = [
      up[0] * c - right[0] * s,
      up[1] * c - right[1] * s,
      up[2] * c - right[2] * s,
    ];
    right = normalize(r2);
    up = normalize(u2);
  }
  return {
    origin: point,
    direction: [-n[0], -n[1], -n[2]],
    right,
    up,
    width: widthMm,
    height: heightMm,
  };
}

/** World point -> decal UV. Image convention: v grows downward. */
export function worldToUV(p: Vec3, proj: PlanarProjector): [number, number] {
  const d = sub(p, proj.origin);
  return [dot(d, proj.right) / proj.width + 0.5, 0.5 - dot(d, proj.up) / proj.height];
}

// --- stamping --------------------------------------------------------------

export type Mask = (u: number, v: number) => boolean;

export interface StampOptions {
  projector: PlanarProjector;
  /** Returns true where the SVG is filled. UV outside 0..1 is never queried. */
  mask: Mask;
  /** Extruder to paint with. Must differ from the model's own extruder. */
  state: number;
  /**
   * Smallest detail worth resolving, in mm. Tree depth is derived per triangle
   * from this. Below ~0.2mm a 0.4mm nozzle cannot render the difference.
   */
  targetFeatureMm?: number;
  /** Hard ceiling on tree depth, whatever the target implies. */
  maxDepth?: number;
  /** Skip faces angled more than this away from the projector, in degrees. */
  maxFacingAngleDeg?: number;
}

export interface StampResult {
  /** The input triangles, unchanged. Returned for convenience only. */
  tris: Tri[];
  /** One entry per triangle, index-aligned with `tris`. */
  segments: string[];
  stats: {
    triangles: number;
    paintedTriangles: number;
    /** Deepest virtual subdivision actually used. */
    maxTreeDepth: number;
    /** Finest detail resolved, in mm — the honest resolution number. */
    effectiveResolutionMm: number;
  };
}

const maxEdge = (t: Tri): number =>
  Math.max(len(sub(t[1], t[0])), len(sub(t[2], t[1])), len(sub(t[0], t[2])));

/**
 * Does this triangle's UV projection touch the decal rectangle at all?
 *
 * Conservative: it tests the triangle's UV bounding box, so it can say "yes" for
 * a triangle that only nearly touches. It must never say "no" for one that does,
 * because this is what lets recursion stop early.
 */
function touchesFootprint(a: Vec3, b: Vec3, c: Vec3, proj: PlanarProjector): boolean {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of [a, b, c]) {
    const [u, v] = worldToUV(p, proj);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  return uMax >= 0 && uMin <= 1 && vMax >= 0 && vMin <= 1;
}

/**
 * Depth needed to resolve `targetMm` on a triangle whose longest edge is `edge`.
 * Each level halves the edge, so this is just a log2 with a ceiling.
 */
export function depthForTriangle(edge: number, targetMm: number, cap: number): number {
  if (targetMm <= 0 || edge <= targetMm) return 0;
  return Math.min(cap, Math.ceil(Math.log2(edge / targetMm)));
}

export function stamp(input: Tri[], opts: StampOptions): StampResult {
  const { projector, mask, state, targetFeatureMm = 0.2, maxDepth = 7, maxFacingAngleDeg = 80 } = opts;

  const facingLimit = Math.cos((maxFacingAngleDeg * Math.PI) / 180);

  // A triangle is a candidate when it faces the projector and lands in the
  // footprint. Back-face culling is what stops the decal bleeding through to
  // the far side of the model.
  const isCandidate = (t: Tri): boolean =>
    dot(triNormal(t), projector.direction) < -facingLimit &&
    touchesFootprint(t[0], t[1], t[2], projector);

  const classify = (p: Vec3): number => {
    const [u, v] = worldToUV(p, projector);
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    return mask(u, v) ? state : 0;
  };

  // Safe early-out for the recursion: a region entirely outside the decal
  // rectangle cannot contain paint, so there's no point subdividing it. This is
  // what keeps the cost proportional to decal area rather than triangle area.
  const isEmpty = (a: Vec3, b: Vec3, c: Vec3): boolean =>
    !touchesFootprint(a, b, c, projector);

  const segments: string[] = [];
  let painted = 0;
  let deepest = 0;
  let finest = Infinity;

  for (const t of input) {
    if (!isCandidate(t)) {
      segments.push('');
      continue;
    }

    const edge = maxEdge(t);
    const depth = depthForTriangle(edge, targetFeatureMm, maxDepth);
    const seg = encode(prune(buildTree(t[0], t[1], t[2], classify, depth, isEmpty)));

    segments.push(seg);
    if (seg) {
      painted++;
      deepest = Math.max(deepest, depth);
      finest = Math.min(finest, edge / 2 ** depth);
    }
  }

  return {
    // Same array, same order, same geometry. Nothing was subdivided.
    tris: input,
    segments,
    stats: {
      triangles: input.length,
      paintedTriangles: painted,
      maxTreeDepth: deepest,
      effectiveResolutionMm: Number.isFinite(finest) ? finest : 0,
    },
  };
}
