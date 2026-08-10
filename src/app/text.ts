/**
 * Text as a decal.
 *
 * The browser will happily *draw* text in any installed font but won't hand
 * over the glyph outlines, and part mode needs real geometry. Bundling a font
 * parser plus font files would cost hundreds of kilobytes and still limit you
 * to whatever we shipped. Instead we render with the system font at high
 * resolution and trace the pixels, which keeps every font on the machine
 * available and adds no dependencies.
 *
 * Traced outlines are polygonal rather than curved, but at 220px per line the
 * error is a fraction of a printed millimetre — well under what a 0.4mm nozzle
 * resolves.
 */

import { traceToPolygons, type Polygon } from '../paint/trace.ts';
import type { Mask } from '../paint/stamp.ts';

export interface TextOptions {
  text: string;
  fontFamily: string;
  bold?: boolean;
  italic?: boolean;
  /** Render height per line, in pixels. Higher means finer outlines. */
  pxPerLine?: number;
}

export interface RenderedText {
  mask: Mask;
  aspect: number;
  preview: HTMLCanvasElement;
  silhouette: HTMLCanvasElement;
  polygons: Polygon[];
}

/** Families offered in the UI. The browser falls back if one isn't installed. */
export const FONT_FAMILIES = [
  'sans-serif',
  'serif',
  'monospace',
  'Arial',
  'Arial Black',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Impact',
  'Comic Sans MS',
  'Segoe UI',
  'Consolas',
];

export function renderText(opts: TextOptions): RenderedText {
  const { text, fontFamily, bold = false, italic = false, pxPerLine = 220 } = opts;

  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error('nothing to render');

  const font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${pxPerLine}px ${fontFamily}`;
  const lineHeight = pxPerLine * 1.25;
  const pad = Math.round(pxPerLine * 0.18);

  // Measure first, on a throwaway context, so the real canvas is sized to fit.
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = font;
  const widest = Math.max(...lines.map((l) => probe.measureText(l).width));
  if (!Number.isFinite(widest) || widest <= 0) throw new Error('the font produced no measurable text');

  const w = Math.ceil(widest + pad * 2);
  const h = Math.ceil(lines.length * lineHeight + pad * 2);

  const preview = document.createElement('canvas');
  preview.width = w;
  preview.height = h;
  const ctx = preview.getContext('2d', { willReadFrequently: true })!;
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  // Black, matching how icon SVGs usually arrive — the library thumbnails apply
  // one inversion for everything, so text and icons look consistent.
  ctx.fillStyle = '#000';
  lines.forEach((line, i) => ctx.fillText(line, w / 2, pad + i * lineHeight));

  const data = ctx.getImageData(0, 0, w, h).data;
  const alphaAt = (x: number, y: number) => data[(y * w + x) * 4 + 3];
  const filled = (x: number, y: number) => alphaAt(x, y) >= 128;

  const mask: Mask = (u, v) => {
    const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
    const y = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
    return filled(x, y);
  };

  const silhouette = document.createElement('canvas');
  silhouette.width = w;
  silhouette.height = h;
  const sctx = silhouette.getContext('2d')!;
  const out = sctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    out.data[i * 4] = 255;
    out.data[i * 4 + 1] = 255;
    out.data[i * 4 + 2] = 255;
    out.data[i * 4 + 3] = data[i * 4 + 3] >= 128 ? 255 : 0;
  }
  sctx.putImageData(out, 0, 0);

  const polygons = traceToPolygons(filled, w, h, {
    tolerance: Math.max(1, pxPerLine / 150),
    // Antialiasing leaves stray specks around glyph edges; anything smaller
    // than this is noise rather than a counter or a dot on an i.
    minArea: Math.max(8, (pxPerLine / 40) ** 2),
  });

  if (polygons.length === 0) throw new Error('the text traced to nothing — try a different font');

  return { mask, aspect: w / h, preview, silhouette, polygons };
}
