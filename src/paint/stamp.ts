/**
 * The stamp engine: project an SVG mask onto mesh triangles and emit MMU paint.
 *
 * Two levers control fidelity, and they are not equivalent:
 *
 *   1. PRE-SUBDIVISION of the mesh inside the decal footprint (`targetEdgeMm`)
 *   2. QUADTREE DEPTH within each triangle (`maxDepth`)
 *
 * Empirically (2026-08-09, PrusaSlicer 2.9.6 on an XL 5T) pre-subdivision gives
 * visibly smoother edges than quadtree depth alone at comparable leaf counts,
 * so it is the primary lever. Quadtree depth then cheaply refines within the
 * already-small triangles. Only triangles inside the footprint get subdivided,
 * so the rest of the model stays cheap.
 */

import { buildTree, encode, prune, subdivide4 } from '../mmu/codec.ts';
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
  /** Extruder to paint with. Must be >= 2 to be visible over a base of 1. */
  state: number;
  /** Pre-subdivide footprint triangles until edges are below this, in mm. */
  targetEdgeMm?: number;
  /** Quadtree depth within each triangle. */
  maxDepth?: number;
  /** Skip faces angled more than this away from the projector, in degrees. */
  maxFacingAngleDeg?: number;
  /** Safety valve so a huge model can't lock the tab up. */
  maxTriangles?: number;
}

export interface StampResult {
  tris: Tri[];
  segments: string[];
  stats: {
    inputTriangles: number;
    outputTriangles: number;
    subdividedTriangles: number;
    paintedTriangles: number;
    hitTriangleLimit: boolean;
  };
}

const maxEdge = (t: Tri): number =>
  Math.max(len(sub(t[1], t[0])), len(sub(t[2], t[1])), len(sub(t[0], t[2])));

/** Does this triangle's UV projection touch the decal rectangle at all? */
function touchesFootprint(t: Tri, proj: PlanarProjector): boolean {
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of t) {
    const [u, v] = worldToUV(p, proj);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  return uMax >= 0 && uMin <= 1 && vMax >= 0 && vMin <= 1;
}

export function stamp(input: Tri[], opts: StampOptions): StampResult {
  const {
    projector,
    mask,
    state,
    targetEdgeMm = 1.0,
    maxDepth = 4,
    maxFacingAngleDeg = 80,
    maxTriangles = 2_000_000,
  } = opts;

  const facingLimit = Math.cos((maxFacingAngleDeg * Math.PI) / 180);

  // A triangle is a candidate when it faces the projector and lands in the
  // footprint. Back-face culling is what stops the decal bleeding through to
  // the far side of the model.
  const isCandidate = (t: Tri): boolean =>
    dot(triNormal(t), projector.direction) < -facingLimit && touchesFootprint(t, projector);

  const classify = (p: Vec3): number => {
    const [u, v] = worldToUV(p, projector);
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    return mask(u, v) ? state : 0;
  };

  const outTris: Tri[] = [];
  const segments: string[] = [];
  let subdivided = 0;
  let painted = 0;
  let hitLimit = false;

  for (const t of input) {
    if (!isCandidate(t)) {
      outTris.push(t);
      segments.push('');
      continue;
    }

    // Pre-subdivide this triangle down to the target edge length.
    let batch: Tri[] = [t];
    if (targetEdgeMm > 0) {
      let guard = 0;
      while (batch.some((b) => maxEdge(b) > targetEdgeMm) && guard < 8) {
        if (outTris.length + batch.length * 4 > maxTriangles) {
          hitLimit = true;
          break;
        }
        const next: Tri[] = [];
        for (const b of batch) {
          if (maxEdge(b) > targetEdgeMm) next.push(...subdivide4(b[0], b[1], b[2]));
          else next.push(b);
        }
        batch = next;
        guard++;
      }
    }
    if (batch.length > 1) subdivided++;

    for (const b of batch) {
      const seg = encode(prune(buildTree(b[0], b[1], b[2], classify, maxDepth)));
      outTris.push(b);
      segments.push(seg);
      if (seg) painted++;
    }
  }

  return {
    tris: outTris,
    segments,
    stats: {
      inputTriangles: input.length,
      outputTriangles: outTris.length,
      subdividedTriangles: subdivided,
      paintedTriangles: painted,
      hitTriangleLimit: hitLimit,
    },
  };
}
