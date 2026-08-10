/**
 * Decal model and edit history.
 *
 * Decals are kept as plain, serializable data — where they sit on the surface,
 * how big, which toolhead. The heavy parts of an SVG (the rasterized mask, the
 * preview canvas) live in a separate asset registry keyed by id, so undo can
 * snapshot the whole document by JSON round-tripping a small array without
 * copying megabytes of pixels.
 *
 * Nothing here touches Three.js or the DOM, so it can be tested headlessly.
 */

import type { Vec3 } from '../mmu/codec.ts';
import type { Mask } from '../paint/stamp.ts';

/** A loaded SVG, shared by any number of placed decals. */
export interface DecalAsset {
  id: string;
  name: string;
  svgText: string;
  mask: Mask;
  /** width / height of the source artwork. */
  aspect: number;
}

/** One placed instance of an asset. */
export interface Decal {
  id: string;
  assetId: string;
  /** Point on the surface the decal is centred on. */
  point: Vec3;
  /** Surface normal at that point. */
  normal: Vec3;
  widthMm: number;
  rollDeg: number;
  /** Toolhead this decal prints with. */
  state: number;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}${++counter}`;

export class DecalStore {
  readonly assets = new Map<string, DecalAsset>();
  decals: Decal[] = [];
  selectedId: string | null = null;

  private past: string[] = [];
  private future: string[] = [];

  // --- assets --------------------------------------------------------------

  addAsset(a: Omit<DecalAsset, 'id'>): DecalAsset {
    const asset: DecalAsset = { ...a, id: nextId('asset') };
    this.assets.set(asset.id, asset);
    return asset;
  }

  assetFor(d: Decal): DecalAsset | undefined {
    return this.assets.get(d.assetId);
  }

  // --- decals --------------------------------------------------------------

  add(d: Omit<Decal, 'id'>): Decal {
    this.commit();
    const decal: Decal = { ...d, id: nextId('decal') };
    this.decals.push(decal);
    this.selectedId = decal.id;
    return decal;
  }

  remove(id: string): void {
    const i = this.decals.findIndex((d) => d.id === id);
    if (i < 0) return;
    this.commit();
    this.decals.splice(i, 1);
    if (this.selectedId === id) {
      this.selectedId = this.decals[Math.min(i, this.decals.length - 1)]?.id ?? null;
    }
  }

  get selected(): Decal | null {
    return this.decals.find((d) => d.id === this.selectedId) ?? null;
  }

  /**
   * Mutate a decal. `coalesce` merges consecutive edits into one undo step,
   * so dragging a slider or a decal doesn't bury the history in noise.
   */
  update(id: string, patch: Partial<Omit<Decal, 'id' | 'assetId'>>, coalesce = false): void {
    const d = this.decals.find((x) => x.id === id);
    if (!d) return;
    if (!coalesce) this.commit();
    Object.assign(d, patch);
  }

  /** Call once when a coalesced gesture starts, e.g. pointer-down on a drag. */
  beginGesture(): void {
    this.commit();
  }

  // --- history -------------------------------------------------------------

  private commit(): void {
    this.past.push(JSON.stringify(this.decals));
    if (this.past.length > 100) this.past.shift();
    this.future.length = 0;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(JSON.stringify(this.decals));
    this.decals = JSON.parse(prev) as Decal[];
    this.ensureSelectionValid();
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(JSON.stringify(this.decals));
    this.decals = JSON.parse(next) as Decal[];
    this.ensureSelectionValid();
    return true;
  }

  private ensureSelectionValid(): void {
    if (!this.decals.some((d) => d.id === this.selectedId)) {
      this.selectedId = this.decals.at(-1)?.id ?? null;
    }
  }
}
