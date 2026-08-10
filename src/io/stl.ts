/** Minimal STL reader. Handles both binary and ASCII, returns a triangle list. */

import type { Tri, Vec3 } from '../mmu/codec.ts';

export function parseSTL(buf: ArrayBuffer): Tri[] {
  return isBinarySTL(buf) ? parseBinary(buf) : parseAscii(new TextDecoder().decode(buf));
}

/**
 * ASCII STL files start with "solid", but so do some binary ones written by
 * sloppy exporters. The reliable test is whether the declared triangle count
 * matches the actual byte length.
 */
function isBinarySTL(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 84) return false;
  const n = new DataView(buf).getUint32(80, true);
  return 84 + n * 50 === buf.byteLength;
}

function parseBinary(buf: ArrayBuffer): Tri[] {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const tris: Tri[] = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12; // skip the per-facet normal
    const v: Vec3[] = [];
    for (let j = 0; j < 3; j++) {
      const b = o + j * 12;
      v.push([dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)]);
    }
    tris.push([v[0], v[1], v[2]]);
  }
  return tris;
}

function parseAscii(text: string): Tri[] {
  const tris: Tri[] = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  const pts: Vec3[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    pts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  }
  for (let i = 0; i + 2 < pts.length; i += 3) tris.push([pts[i], pts[i + 1], pts[i + 2]]);
  return tris;
}

/** Flatten a triangle list into an interleaved Float32Array for Three.js. */
export function trisToPositions(tris: Tri[]): Float32Array {
  const out = new Float32Array(tris.length * 9);
  let k = 0;
  for (const t of tris) {
    for (const v of t) {
      out[k++] = v[0];
      out[k++] = v[1];
      out[k++] = v[2];
    }
  }
  return out;
}

export function boundingBox(tris: Tri[]): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const v of t) {
      for (let i = 0; i < 3; i++) {
        if (v[i] < min[i]) min[i] = v[i];
        if (v[i] > max[i]) max[i] = v[i];
      }
    }
  }
  return { min, max };
}
