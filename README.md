# SVGMesh

Stamp SVGs onto STL surfaces as **PrusaSlicer MMU paint data** — not geometry — and export a
`.3mf` with the decal already assigned to a toolhead.

Runs entirely in your browser. No server, no account, no upload. Your models never leave your
machine.

> **Status: early.** The encoding core is validated against real PrusaSlicer output and the MVP
> app runs. Placement is planar only. See [`projectplan.md`](projectplan.md) for where things
> actually stand.

## Why

PrusaSlicer has an SVG emboss tool, but it works by **adding geometry** — it modifies your mesh
and gives raised or recessed relief. If you want a *flush* multi-colour logo, what you actually
want is the data PrusaSlicer writes when you hand-paint with the multimaterial brush.

Nothing free and local does SVG → that data. Bambu's Mesh Graffiti does something similar, but
it's cloud-only, account-gated, and exports for Bambu Studio and the AMS rather than PrusaSlicer
and a tool-changer.

So: pick an STL, drop an SVG on it, position it, export a 3MF that opens in PrusaSlicer with the
artwork already on toolhead 2 (or 3, 4, 5).

## How it works

1. The SVG is rasterized to an alpha mask — the browser's own SVG renderer handles fill rules,
   clip paths, strokes and nested groups correctly, which hand-rolled path parsing rarely does
2. You click the model to place a planar projector, then set size and rotation
3. Triangles inside the footprint are pre-subdivided, then each is adaptively subdivided into a
   quadtree tested against the mask
4. Each triangle's tree is encoded to PrusaSlicer's `slic3rpe:mmu_segmentation` hex string
5. A 3MF is assembled with the paint data plus the per-volume extruder assignment

Back faces and steeply-angled faces are culled, so a decal on the front doesn't bleed through to
the back.

### Two fidelity levers, and they're not equivalent

Pre-subdividing the mesh inside the footprint gives **visibly smoother edges** than quadtree
depth alone at comparable cost. Testing on PrusaSlicer 2.9.6 with an XL 5T made this clear, so
pre-subdivision is the primary lever and tree depth refines within the already-small triangles.
The Detail dropdown drives both together.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # codec + stamp engine, no browser needed
npm run build
```

Requires Node 22.6+ (the tests use native TypeScript type stripping, so there's no test runner
dependency).

## Using it

1. Load an STL
2. Load an SVG — use one with a transparent background; a white background becomes a painted region
3. Click the model where you want the decal
4. Set width, rotation, and which toolhead the decal prints with
5. Export, then open the 3MF in PrusaSlicer

### Two things that will confuse you if nobody warns you

**Give your filaments distinct colours.** PrusaSlicer renders the 3D view by *filament* colour,
not extruder colour. If several filament slots share a colour, different toolheads look
identical and you'll think the paint didn't apply.

**Painting with toolhead 1 over a model that already prints on toolhead 1 does nothing visible.**
State 1 and "unpainted" resolve to the same extruder. That's correct behaviour, not a bug — the
app blocks the case where the decal and model share a toolhead.

## The format

PrusaSlicer stores painting as a per-triangle subdivision tree serialized to a hex string.
Bambu Studio and OrcaSlicer use the identical bitstream under `paint_color`.

Reading the string **backwards**, bits LSB-first within each nibble:

```
node := split:2 ( state:2 [ext:4 when state == 0b11, value = ext + 3]   -- leaf
                | specialSide:2 node{split+1} )                         -- split
```

`split` 0 is a leaf, 1/2/3 mean 2/3/4 children. States 0–2 encode directly; state ≥ 3 uses a
marker plus a 4-bit extension, capping at 18. State 0 means unpainted and falls back to the
volume's extruder; **state N paints extruder N**.

Verified against PrusaSlicer 2.9.6 output: 30 hand-painted triangles decode and re-encode
byte-for-byte, and those strings are checked into `src/mmu/codec.test.ts` as regression
fixtures. If a future PrusaSlicer changes the format, the tests fail immediately.

## Layout

```
src/mmu/codec.ts       encode/decode, tree utilities, subdivision
src/paint/stamp.ts     projector, footprint query, adaptive subdivision
src/paint/svgMask.ts   SVG rasterization and sampling
src/io/stl.ts          STL reader (binary + ASCII)
src/io/threemf.ts      3MF writer
src/main.ts            app
phase0/                Python validation scripts and 3MF generators
```

`phase0/` holds the standalone Python tools used to reverse-engineer and verify the format.
They're stdlib-only — `python3 phase0/test_codec.py` and `python3 phase0/make_toolhead_probe.py`
still work and remain useful for generating diagnostic files.

## Roadmap

- Cylindrical and conformal projection for curved surfaces
- Multiple live, re-editable decals per model
- Text tool
- Basic modeling: primitives, booleans
- Offline PWA

## Prior art and credit

- [MMU segmentation format documentation](https://github.com/coreynguyen/prusa_mmu_painter) — the
  reverse-engineering that made this straightforward
- [Panda2Prusa](https://github.com/CupsOhJoe/Panda2Prusa) — independent implementation of the
  same bitstream; cross-checking against it confirmed the grammar
- [PrusaSlicer](https://github.com/prusa3d/PrusaSlicer) — `TriangleSelector.cpp` is the source of truth

## License

MIT
