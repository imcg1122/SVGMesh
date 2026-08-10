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

## Two output modes

**Parts** (default) extrudes each SVG into a thin prism and embeds it just under the model
surface as a real volume. PrusaSlicer unions part volumes with their object and the part's
extruder wins in the overlap, so you get flush colour with no bump — plus:

- the decal appears in PrusaSlicer's object tree with its own toolhead dropdown
- smart fill and bucket fill work on it, because it's geometry with real edges
- colour depth is exactly the prism thickness, so "two layers deep" is something you set

**Paint** writes per-triangle MMU segmentation and never touches the mesh. Nothing to
repair, works on any surface however awkward, and costs no geometry — but it's only
editable with the paint brush, doesn't appear as a part, and the slicer decides how far
into the model the colour reaches.

Rule of thumb: parts when you want to keep editing in the slicer, paint when you want the
mesh left alone.

## How it works

1. The SVG is rasterized to an alpha mask — the browser's own SVG renderer handles fill rules,
   clip paths, strokes and nested groups correctly, which hand-rolled path parsing rarely does
2. You click the model to place a planar projector, then set size and rotation
3. Each triangle in the footprint gets a **virtual** subdivision tree, tested against the mask
4. Each tree is encoded to PrusaSlicer's `slic3rpe:mmu_segmentation` hex string
5. A 3MF is assembled with the paint data plus the per-volume extruder assignment

Back faces and steeply-angled faces are culled, so a decal on the front doesn't bleed through to
the back.

### The mesh is never modified

This is the central rule. PrusaSlicer's subdivision tree is *virtual* — the slicer applies it at
slice time and the geometry stays byte-identical. Your STL goes in and comes out untouched.

That matters more than it sounds. An earlier version pre-subdivided triangles inside the decal
footprint, which seemed like a quality win and wasn't: subdividing one triangle and not its
neighbour creates T-junctions. A watertight 108-triangle token came out with 108 open edges,
PrusaSlicer demanded a repair, and the repair rebuilt the mesh and threw away all the paint.
There's a test asserting watertightness is preserved so it can't come back.

### Detail is a distance, not a quality slider

Fidelity has one lever: the smallest feature worth resolving, in millimetres. Tree depth is
derived per triangle from its own size, so a coarse mesh and a dense one land on the same
real-world resolution.

Measured on a 25mm hexagon token:

| Detail | Tree depth | Resolved | Paint data |
|--------|-----------|----------|------------|
| 0.4 mm | 4 | 0.391 mm | 1.1 KB |
| 0.2 mm | 5 | 0.195 mm | 2.5 KB |
| 0.1 mm | 6 | 0.098 mm | 5.9 KB |
| 0.05 mm | 7 | 0.049 mm | 12.3 KB |

A 0.4mm nozzle can't render much below 0.2mm, so finer settings mostly buy file size. For
reference, PrusaSlicer's own brush produces trees 4–5 deep.

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
2. Add SVGs — they stay in a library for the session, so you can place any of them at any
   time. Use transparent backgrounds; a white background becomes a painted region
3. Click a thumbnail to arm it, then click the model to place a decal
4. Position it: **drag** on the model, **arrow keys** to nudge by 0.01–5 mm, or the
   **align** buttons to centre it on the face
5. Set width, rotation and toolhead — sliders or type exact numbers
6. Export, then open the 3MF in PrusaSlicer

**Copy to opposite face** stamps the same artwork on the far side, positioned to match,
with the artwork flipped so it reads correctly from that side — coins, tokens, badges.

Ctrl+Z / Ctrl+Shift+Z undo and redo; a whole drag is one undo step. Delete removes the
selected decal. Overlapping paint-mode decals resolve last-wins.

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
src/paint/stamp.ts     projector, footprint query, multi-decal painting
src/paint/svgMask.ts   SVG rasterization and sampling
src/paint/extrude.ts   SVG outlines to 3D prisms (part mode)
src/app/decals.ts      decal model and undo history (no Three.js, no DOM)
src/io/stl.ts          STL reader (binary + ASCII)
src/io/threemf.ts      multi-volume 3MF writer
src/main.ts            viewport, interaction, panel
phase0/                Python validation scripts and 3MF generators
```

The engine is deliberately separable from the app: `codec`, `stamp`, `decals` and `threemf`
have no Three.js or DOM dependencies, which is why they're covered by 180 headless tests.

`phase0/` holds the standalone Python tools used to reverse-engineer and verify the format.
They're stdlib-only — `python3 phase0/test_codec.py` and `python3 phase0/make_toolhead_probe.py`
still work and remain useful for generating diagnostic files.

## Roadmap

- Cylindrical and conformal projection for curved surfaces
- Scale and rotate handles on the decal itself, not just sliders
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
