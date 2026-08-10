/**
 * SVG -> alpha mask.
 *
 * Rasterizing and sampling alpha is deliberately chosen over parsing paths into
 * polygons: even-odd fill rules, clip paths, strokes, transforms and nested
 * groups all come free from the browser's own SVG renderer. Mask resolution is
 * not the fidelity bottleneck — mesh subdivision is — so a generous raster is
 * cheap insurance.
 */

import type { Mask } from './stamp.ts';

export interface SvgMask {
  mask: Mask;
  /** width / height of the source artwork, for non-distorting placement. */
  aspect: number;
  /** The artwork as drawn, for library thumbnails. */
  preview: HTMLCanvasElement;
  /**
   * Solid white wherever the artwork is filled, transparent elsewhere.
   *
   * The 3D preview tints decals by toolhead colour, and a texture multiplies
   * into that tint — so drawing the original artwork would turn a black logo
   * black regardless of the toolhead. A white silhouette multiplies cleanly and
   * shows the actual print colour.
   */
  silhouette: HTMLCanvasElement;
}

export interface RasterizeOptions {
  /** Longest edge of the raster, in pixels. */
  resolution?: number;
  /** Alpha above this counts as filled, 0..255. */
  alphaThreshold?: number;
  /** Treat filled areas as holes instead. */
  invert?: boolean;
}

export async function rasterizeSvg(svgText: string, opts: RasterizeOptions = {}): Promise<SvgMask> {
  const { resolution = 2048, alphaThreshold = 128, invert = false } = opts;

  const aspect = readAspect(svgText);
  const w = aspect >= 1 ? resolution : Math.max(1, Math.round(resolution * aspect));
  const h = aspect >= 1 ? Math.max(1, Math.round(resolution / aspect)) : resolution;

  const img = await loadSvgImage(svgText, w, h);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('could not get a 2D canvas context');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h).data;

  const mask: Mask = (u, v) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
    const filled = data[(y * w + x) * 4 + 3] >= alphaThreshold;
    return invert ? !filled : filled;
  };

  return { mask, aspect, preview: canvas, silhouette: buildSilhouette(data, w, h, alphaThreshold, invert) };
}

function buildSilhouette(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  alphaThreshold: number,
  invert: boolean,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const filled = src[i * 4 + 3] >= alphaThreshold;
    const on = invert ? !filled : filled;
    out.data[i * 4] = 255;
    out.data[i * 4 + 1] = 255;
    out.data[i * 4 + 2] = 255;
    out.data[i * 4 + 3] = on ? 255 : 0;
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

/** viewBox is the reliable source of aspect; width/height attrs are optional. */
function readAspect(svgText: string): number {
  const vb = svgText.match(/viewBox\s*=\s*["']\s*([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)[\s,]+([\d.eE+-]+)/);
  if (vb) {
    const w = parseFloat(vb[3]);
    const h = parseFloat(vb[4]);
    if (w > 0 && h > 0) return w / h;
  }
  const w = svgText.match(/\bwidth\s*=\s*["']([\d.]+)/);
  const h = svgText.match(/\bheight\s*=\s*["']([\d.]+)/);
  if (w && h) {
    const wv = parseFloat(w[1]);
    const hv = parseFloat(h[1]);
    if (wv > 0 && hv > 0) return wv / hv;
  }
  return 1;
}

function loadSvgImage(svgText: string, w: number, h: number): Promise<HTMLImageElement> {
  // Force intrinsic dimensions; an SVG without width/height renders at 0 in some browsers.
  let sized = svgText;
  if (!/<svg[^>]*\bwidth\s*=/.test(sized)) {
    sized = sized.replace(/<svg\b/, `<svg width="${w}" height="${h}"`);
  }
  const blob = new Blob([sized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not rasterize the SVG'));
    };
    img.src = url;
  });
}
