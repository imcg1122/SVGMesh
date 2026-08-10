/**
 * SVG outline -> a thin 3D prism sitting flush in the model surface.
 *
 * This is what "part mode" needs. Paint mode only ever asks "is this point
 * inside the artwork?", which a raster mask answers perfectly well. A part has
 * to be real geometry, so here the SVG's paths are turned into filled shapes
 * (holes and fill rules included) and extruded.
 *
 * The prism is positioned so its TOP face sits a hair proud of the surface and
 * the rest sinks inward. PrusaSlicer unions part volumes with their object and
 * the part's extruder wins in the overlap, so the visible result is flush
 * colour with no bump — and the colour reaches exactly as deep as the prism is
 * thick, which is the point: depth becomes something you set rather than
 * something the slicer decides.
 *
 * Browser-only: SVGLoader parses with DOMParser.
 */

import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { Tri, Vec3 } from '../mmu/codec.ts';
import type { Polygon } from './trace.ts';
import { projectorFromHit } from './stamp.ts';

export interface ExtrudeOptions {
  /** Surface point the decal is centred on. */
  point: Vec3;
  /** Surface normal there. */
  normal: Vec3;
  widthMm: number;
  heightMm: number;
  thicknessMm: number;
  rollRad?: number;
  mirrorX?: boolean;
}

/** Cache parsed shapes — re-parsing an SVG on every slider tick is wasteful. */
const shapeCache = new Map<string, THREE.Shape[]>();

export function parseSvgShapes(svgText: string): THREE.Shape[] {
  const hit = shapeCache.get(svgText);
  if (hit) return hit;

  const data = new SVGLoader().parse(svgText);
  const shapes: THREE.Shape[] = [];
  for (const path of data.paths) {
    // createShapes resolves holes and the path's own fill rule.
    for (const s of SVGLoader.createShapes(path)) shapes.push(s);
  }
  shapeCache.set(svgText, shapes);
  return shapes;
}

/**
 * Traced polygons -> Three shapes.
 *
 * Used for text, which has no SVG paths to read, and as a fallback for
 * stroke-only SVGs that legitimately produce no fillable shapes. Input
 * coordinates are normalized 0..1; the extruder rescales anyway, so the only
 * thing that matters here is preserving proportion and hole structure.
 */
export function polygonsToShapes(polys: Polygon[], aspect = 1): THREE.Shape[] {
  return polys.map((poly) => {
    const shape = new THREE.Shape();
    const trace = (pts: readonly (readonly [number, number])[], path: THREE.Path) => {
      pts.forEach(([x, y], i) => {
        const px = x * aspect;
        if (i === 0) path.moveTo(px, y);
        else path.lineTo(px, y);
      });
      path.closePath();
    };
    trace(poly.outer, shape);
    for (const hole of poly.holes) {
      const p = new THREE.Path();
      trace(hole, p);
      shape.holes.push(p);
    }
    return shape;
  });
}

/**
 * Build the decal prism from ready-made shapes and return world-space triangles.
 */
export function extrudeShapes(shapes: THREE.Shape[], opts: ExtrudeOptions): Tri[] {
  if (shapes.length === 0) return [];

  const { point, normal, widthMm, heightMm, thicknessMm, rollRad = 0, mirrorX = false } = opts;

  const geom = new THREE.ExtrudeGeometry(shapes, {
    depth: thicknessMm,
    bevelEnabled: false,
    curveSegments: 24,
  });

  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  const sx = bb.max.x - bb.min.x || 1;
  const sy = bb.max.y - bb.min.y || 1;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;

  // Centre on the origin, then scale to the requested footprint. SVG's y axis
  // points down, so flip it to match how the artwork is previewed.
  const m = new THREE.Matrix4();
  m.makeTranslation(-cx, -cy, 0);
  m.premultiply(
    new THREE.Matrix4().makeScale((mirrorX ? -1 : 1) * (widthMm / sx), -(heightMm / sy), 1),
  );

  // Sink the prism so its top face is fractionally proud of the surface. Exact
  // coplanarity makes slicers ambiguous about which volume owns the face.
  const proud = 0.01;
  m.premultiply(new THREE.Matrix4().makeTranslation(0, 0, proud - thicknessMm));

  const p = projectorFromHit(point, normal, widthMm, heightMm, rollRad);
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...p.right),
    new THREE.Vector3(...p.up),
    new THREE.Vector3(-p.direction[0], -p.direction[1], -p.direction[2]),
  );
  basis.setPosition(new THREE.Vector3(...point));
  m.premultiply(basis);

  geom.applyMatrix4(m);

  const nonIndexed = geom.index ? geom.toNonIndexed() : geom;
  const pos = nonIndexed.getAttribute('position') as THREE.BufferAttribute;

  const tris: Tri[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    tris.push([
      [pos.getX(i), pos.getY(i), pos.getZ(i)],
      [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)],
      [pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)],
    ]);
  }

  geom.dispose();
  if (nonIndexed !== geom) nonIndexed.dispose();
  return tris;
}

/**
 * Build the decal prism from an SVG.
 * Returns an empty array if the SVG has no fillable geometry (stroke-only art) —
 * callers can fall back to traced polygons.
 */
export function extrudeSvg(svgText: string, opts: ExtrudeOptions): Tri[] {
  return extrudeShapes(parseSvgShapes(svgText), opts);
}
