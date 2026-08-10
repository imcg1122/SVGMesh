# MeshStamp — Living Project Plan

> **This is the single source of truth for the project.** Read it first at the start of a
> session; update it whenever something is finished, decided, discovered or changed.
> See `CLAUDE.md` for the working agreement.

**Last updated:** 2026-08-09
**Repo:** https://github.com/imcg1122/SVGMesh

---

## 1. Status at a glance

| | |
|---|---|
| **Phase** | 1 complete ✅ — end-to-end workflow verified in PrusaSlicer. Next: Phase 2 UX. |
| **Phase 0** | ✅ **CLOSED.** Format fully validated in both directions. |
| **Decoder** | ✅ 30/30 real PrusaSlicer 2.9.6 triangles parse and re-encode byte-for-byte |
| **Encoder** | ✅ Accepted by PrusaSlicer. **Mapping confirmed direct: state N → extruder N.** No bug — the original confusion was five identically-coloured filaments. |
| **Repo** | ✅ Pushed. https://github.com/imcg1122/SVGMesh — public, CI green, 96 tests passing |
| **Live app** | ✅ https://imcg1122.github.io/SVGMesh/ — auto-deploys from `main` |
| **Verified** | Cutlery icon on hexagon token: correct toolhead, no open edges, no repair needed |
| **Blocked on** | Ian to choose Phase 2 priorities (§7) |

---

## 2. Goal

A UI app that takes an existing STL, places an SVG on its surface as **MMU paint data
rather than geometry**, lets you position/scale/rotate it interactively, and exports a
`.3mf` that opens in PrusaSlicer with the decal already assigned to a toolhead on Ian's
Prusa XL 5-toolhead.

### Scope correction (2026-08-09) — this is not a painting app

**Freehand surface painting is explicitly out of scope.** PrusaSlicer's brush already does
that adequately. The entire value of this tool is making **SVG placement and manipulation**
better than PrusaSlicer's SVG emboss tool, which Ian describes as wonky and feature-limited.

Consequences:
- No brush, no eraser, no per-triangle manual editing in v1
- Every interaction is about *the decal as an object*: position, scale, rotate, mirror,
  project, layer, re-edit
- Decals stay **live and re-editable** — non-destructive until export

### Why not just use PrusaSlicer

Its SVG emboss tool works by **adding geometry**. It has the "Use surface" bugs Ian has
hit, it modifies the model, and gives raised/recessed relief rather than a flush painted
region. No free local tool does SVG → MMU paint data.

---

## 3. The reference target: MakerWorld Mesh Graffiti

Bambu's Mesh Graffiti (browser tool in MakerLab, beta since April 2026) is the closest
thing to what Ian wants. Feature set worth matching:

| Mesh Graffiti feature | Our stance |
|---|---|
| Image stamp — PNG/SVG/JPEG onto surface | **Core.** SVG first; raster later |
| Transform gizmo: click to place, drag, scale handles, rotation arc | **Core.** This is the whole UX |
| Wraps/conforms to curved surfaces (cylinders, spheres) | **Phase 2.** Planar first |
| Text tool with font library, conforming to surface | **Phase 3.** Or export text→SVG |
| Colour zone panel mapping zones → filament slots | **Core.** Ours maps to XL toolheads |
| Smooth (anti-aliased) vs faceted edges | Interesting — investigate. Faceted is what MMU segmentation natively gives |
| Export 3MF with zones pre-assigned | **Core** |

Where it falls short for Ian, i.e. our reasons to exist: cloud-only and account-gated,
free only during beta with unconfirmed credit pricing afterwards, and it targets
Bambu/AMS — the 3MF lands in Bambu Studio, not PrusaSlicer with XL toolheads.

Their documented weak spots to avoid inheriting: photographic gradients degrade badly
(fine — we're vector-first), and high-poly meshes are sluggish in-browser (we plan for
workers and BVH from the start).

---

## 4. The format — confirmed and cross-validated

PrusaSlicer stores painting as a per-triangle tree serialized to a hex string in
`slic3rpe:mmu_segmentation` on triangles in `3D/3dmodel.model`. Bambu/Orca use the
identical bitstream under `paint_color` (Bambu forked PrusaSlicer's `TriangleSelector`).

- Read the string **backwards**; bits LSB-first within each nibble
- Grammar: `node := split:2 ( state:2 [ext:4 if state==0b11, value = ext+3] | special_side:2 node{split+1} )`
- `split`: 0=leaf, 1=2 children, 2=3 children, 3=4 children
- States 0–2 encode directly; **state ≥ 3 uses marker `0b11` + a 4-bit extension**, so the
  maximum representable state is 18
- Children written pre-order; 4-way order is Center, Corner2, Corner1, Corner0
- State 0 = unpainted → uses the volume's own extruder

**Independently confirmed** by decoding Ian's hand-painted `painted blob test.3mf`
(PrusaSlicer 2.9.6, XL5IS profile): 108 triangles, 30 painted, all parse, all re-encode
byte-for-byte. Our implementation and Panda2Prusa's agree on the grammar.

### ✅ Resolved: the state → toolhead mapping is DIRECT

**State N paints extruder N.** Confirmed twice on 2026-08-09:

1. `toolhead_probe.3mf` rendered five distinct patches; the second from the left (state 2)
   is **TH2**. Patch 6 (state 6) does not render — there is no sixth toolhead on a 5T.
2. Ian painted `painted blob test.3mf` with **TH2**, and that file contains exactly state 2.

Panda2Prusa's documentation was right. There was never an encoder bug. The earlier
confusion came entirely from the profile issue below, compounded by the fact that **state 1
is invisible over a model whose own extruder is 1** — painting extruder 1 onto an
extruder-1 body is a no-op by definition, so our first test cube looked like it had "lost"
a stripe.

**Design consequence:** the app must refuse to export when the decal state equals the base
volume's extruder, because the result is silently invisible. Implemented in `main.ts`.

### ⚠️ Profile gotcha found in Ian's setup

His XL5IS profile has **all five `filament_colour` set to the same `#FF8000`**:

```
extruder_colour = #FF8000;#DB5182;#3EC0FF;#FF4F4F;#FBEB7D
filament_colour = #FF8000;#FF8000;#FF8000;#FF8000;#FF8000
```

PrusaSlicer renders the 3D scene by filament colour, so five identical oranges make
toolhead assignments visually indistinguishable. **Set five distinct filament colours
before evaluating any test file**, or judge from the sliced preview rather than the 3D view.

Related, from Panda2Prusa's README: PrusaSlicer only renders multi-colour assignments
under a profile that actually has multiple tools. Ian's XL5IS qualifies, so that's fine.

---

## 5. Architecture

**Client-side web app. No server, no cloud, no infra cost.** GitHub Pages + offline PWA.
Optional Tauri desktop wrapper later.

| Concern | Choice |
|---|---|
| Build | Vite + TypeScript |
| Viewport | Three.js |
| Raycasting / surface queries | `three-mesh-bvh` |
| Booleans (modeling layer) | `three-bvh-csg` |
| 3MF read/write (it's a zip) | `fflate` |
| SVG → fill test | Rasterize to offscreen canvas, sample alpha |

Rasterizing the SVG to an alpha mask beats parsing paths to polygons: even-odd fill rules,
clip paths, strokes and nested groups all come free from the browser's own SVG renderer.
Mask resolution isn't the bottleneck — subdivision depth is.

### The stamp pipeline

1. Load STL/3MF → BufferGeometry, weld duplicate vertices
2. Load SVG → rasterize to alpha mask
3. User places a **projector** on the model, with a transform gizmo
4. **Footprint query** via BVH; back-face and steep-angle culled so the decal doesn't bleed
   through to the far side
5. **Adaptive subdivision** per triangle: sample mask at 3 corners + centroid; all agree →
   leaf; disagree and depth < max → split, recurse
6. **Encode** each tree
7. **Write 3MF** with the `slic3rpe` namespace, per-triangle attributes,
   `MmPaintingVersion` metadata, and `Slic3r_PE_model.config` carrying the toolhead
   assignment

---

## 6. Phases

- **Phase 0 — Encoding spike** *(nearly done)* — decoder ✅, encoder pending §7
- **Phase 1 — MVP** — load STL → load SVG → planar placement with gizmo → export 3MF
- **Phase 2 — Placement UX** — cylindrical then conformal projection, multiple live
  decals, SVG library, undo/redo, detail-vs-filesize control
- **Phase 3 — Modeling layer** — primitives, booleans, 3D text, per-object extruder
- **Phase 4 — Ship** — workers, offline PWA, GitHub Pages, optional Tauri

---

## 7. Needs from Ian — current asks

**① Print one.** Everything left is preview-versus-reality. A token with a decal on each
face, at 0.6mm depth, would confirm colour opacity and edge quality in the only way that
counts.

**② Does the opposite-face copy read the right way round?** It's confirmed working
mechanically, but I default to flipping the artwork and haven't seen a physical token to
know whether that's right. If it reads backwards, untick the flip toggle and say so.

**③ Pick the next direction** — see §9.

### Verified ✅

- Part mode: decals appear as parts in PrusaSlicer, smart fill and bucket fill work on them
- Copy to opposite face
- Paint mode: correct toolhead, watertight mesh, no repair prompt

### Remaining known gaps

No scale/rotate handles on the decal itself (sliders and typed values only), no copy/paste,
no snapping to model features, no cylindrical projection, per-decal thickness is fixed at
placement time from the global field rather than editable afterwards.

### Received ✅

- `phase0/painted blob test.3mf` — ground truth; decoder validated against it, and its 30
  segmentation strings are now permanent regression fixtures in `src/mmu/codec.test.ts`
- `phase0/blank small hexagon token.stl` — 25 × 21.65 × 2 mm, 108 triangles
- `phase0/food-restaurant-icon.svg` — viewBox 122.88 × 115.21, cutlery icon, thin strokes
- `phase0/toolhead_probe.3mf` — answered: mapping is direct

Test assets are **gitignored** — the icon is third-party artwork and the `.3mf` files are
regenerable from the scripts. Worth keeping out of a public repo.

---

## 8. Risks

**1. Edge crispness — ✅ effectively retired 2026-08-10.** The earlier "Variant B is
smoother" conclusion was wrong, or at least misattributed: both variants were already
resolving far below what a 0.4mm nozzle can print, and the real difference was the
sample-agreement bug dropping detail. With subdivision now unconditional and expressed in
millimetres, 0.2mm resolution is reached at tree depth 5 for ~2.5KB of paint data on a 25mm
part. The binding constraint is the nozzle, not the encoding.

Remaining unknown: how it looks **printed**, versus in preview. Worth one physical test.

**2. T-junctions — ✅ RETIRED 2026-08-10.** This one bit us for real: geometry
pre-subdivision produced 144 open edges, PrusaSlicer demanded a repair, and the repair
destroyed the paint. Retired *by construction* — the mesh is no longer modified at all, so
T-junctions cannot occur. A test asserts watertightness is preserved.

PrusaSlicer's own brush still leans on partial 2-way and 3-way splits (246/108/37 in Ian's
ground-truth file) and we emit only 4-way. That's now a cosmetic question at sub-resolution
scale rather than a geometric one, since the tree is virtual. The codec supports partial
splits if boundary quality ever demands them.

**3. Format drift.** Undocumented by Prusa. Mitigation: the round-trip test against real
output is now a permanent regression test.

**4. Conformal wrapping is genuinely hard.** Geodesic parameterization is research-grade.
Planar in v1, cylindrical next — those cover most real use, and this is exactly where
PrusaSlicer's own tool falls over.

**5. Large meshes in-browser.** BVH handles queries; heavy work goes to workers.

---

## 9. Open decisions

- Should painting and embossing coexist? Complementary, different export paths. Leaning
  yes, not before Phase 2.
- Should pre-subdivision be automatic or a user-facing slider? Leaning automatic with an
  override, given Variant B's clear win.
- Mesh Graffiti's "smooth vs faceted edges" — is a smooth mode even meaningful for MMU
  segmentation, which is inherently faceted? Investigate.

---

## 10. Reference material

- [MMU segmentation format docs](https://github.com/coreynguyen/prusa_mmu_painter/blob/master/wiki/MMU-Segmentation-Format.md)
- [Panda2Prusa](https://github.com/CupsOhJoe/Panda2Prusa) — Bambu→Prusa 3MF converter.
  `panda2prusa/paint.py` is an independent implementation of the same bitstream and
  confirms our grammar. Its extruder-renumbering logic is directly relevant: paint strings
  **cannot** be value-preserved when extruders are renumbered; leaf states must be rewritten.
- [Mesh Graffiti guide](https://3dbite.com/bambu-lab-mesh-graffiti-guide/) — feature
  reference for the UX we're targeting
- [PrusaSlicer SVG embossing tool](https://help.prusa3d.com/article/svg-embossing-tool_686167)
- [PrusaSlicer TriangleSelector.cpp](https://github.com/prusa3d/PrusaSlicer/blob/master/src/libslic3r/TriangleSelector.cpp)

---

## 11. Changelog

### 2026-08-10 — v0.5.1: open edges in part mode; stranded library assets

**Open edges were back, on a dice STL — and this time in part mode, not paint mode.**

Measured first, as usual. The dice STL is flawless: 22,556 triangles, 0 open edges at every
rounding tolerance, no degenerate or duplicate faces. Paint mode output on it: also 0 open
edges. So the fault was in the decal prisms.

**Cause: degenerate triangles at curve seams.** A closed curve duplicates its start point,
and `ExtrudeGeometry` dutifully emits a zero-width quad there. Those triangles have no area
and no meaning, but two of their corners weld into one, which reports as an open edge —
and then PrusaSlicer demands a repair, and the repair destroys the paint. Excluding them,
every prism was already perfectly watertight, all edges used exactly twice.

Why the token never showed it: its icon happened not to exercise the seam case the same
way. A ring built from `absarc` produced 4 degenerate triangles and 6 open edges; from
explicit points, none. So this was always latent for curved artwork.

Fixed in two places: `extrudeShapes` drops them as it builds, comparing at the same 6
decimal places the writer welds at, so nothing judged fine can collapse later; and
`build3mf` skips them for any volume from any source, as a backstop. Spans and paint
alignment are preserved. Verified: a ring from arcs and a three-ring icon now both come out
0 degenerate, 0 open.

**Removing an unplaced SVG left a broken thumbnail.** `removeByAsset` returned early when
no decals used the asset — before deleting the asset itself — while the UI had already
discarded its thumbnail. The asset stayed in the library rendering as a broken image.
Deleting from the library no longer depends on anything being placed, and the grid renders
nothing rather than an empty `<img>` if a thumbnail is ever missing.

227 → 236 tests.


### 2026-08-10 — v0.5.0: text tool (Phase 3)

Ian chose the text tool for Phase 3.

**The hard part was part mode.** Paint mode only ever asks "is this point inside the
artwork?", which a rendered canvas answers directly. Part mode needs real geometry, and
browsers expose no way to get glyph outlines — only the pixels a font draws. The
alternatives were to bundle a font parser plus font files (hundreds of KB, and limited to
whatever we shipped) or to derive outlines from the render.

**Built a raster-to-polygon tracer** (`src/paint/trace.ts`). Every filled cell contributes
the sides facing an empty neighbour as directed edges; shared interior sides are never
emitted, so survivors chain into closed loops. Signed area separates outers from holes,
and each hole nests into the smallest outer containing it — which is what makes the letter
"O" a ring rather than a disc, and handles a counter inside a shape inside a larger shape.

Two subtleties worth recording:

- **Closed-loop simplification needed its own routine.** Plain Douglas–Peucker pins the
  first and last points, which for a loop means pinning wherever tracing happened to start
  — usually mid-edge — leaving a spurious vertex and making the output depend on the
  starting point. `simplifyClosed` anchors at an extreme point (always a true corner) and
  splits at the point farthest from it. There's a test asserting rotation invariance.
- **The winding convention is now documented in the code**, because getting it backwards
  silently reclassifies every outline as a discarded hole — which is exactly what my first
  test fixtures did.

**Bonus:** the tracer is a general mask-to-outline converter, so part mode now falls back
to tracing for stroke-only SVGs. Those previously errored out, since SVGLoader correctly
returns zero fillable shapes for them.

Text supports multi-line, any installed font, and bold. 47 trace tests; 227 total.


### 2026-08-10 — v0.4.2: part mode confirmed working; stale-build detection

**Part mode verified in PrusaSlicer by Ian: smart fill and bucket fill work on the decals.**
That was the whole point of the mode, and it closes the loop on his UX review. Copy to
opposite face also confirmed working.

**Opposite-face detection simplified and made side-independent.** It now casts from
*outside* the far side inward — which is just `snapToSurface` looking the other way —
rather than firing outward from inside the mesh. The inside-out ray only worked because
the material happened to be DoubleSide; the outside-in ray hits a front face on any
correctly wound mesh and depends on nothing. Verified on the token under both FrontSide
and DoubleSide, centred and off-centre. The DoubleSide change is kept anyway, since it
still helps STLs with inconsistent winding.

**Stale-build detection added — this bit us twice.** Both times a fix was already correct
and deployed, and both times the browser was running an old bundle from a cached
index.html; each cost a full debugging round trip. The app now compares the script tag it
actually loaded against the one the server is serving right now, fetched with
`cache: 'no-store'` so it can't be answered from the same stale cache, and shows a reload
banner when they differ. Checked on load, on window focus, and every five minutes.

No version file to keep in sync: Vite's content-hashed bundle name already changes on every
build, so the check maintains itself.


"Copy to opposite face" failed on the hexagon token. Cause: **Three.js culls raycast hits
by `material.side`**, and the model material was `FrontSide`. The ray for this feature
starts *inside* the model and travels outward, so it strikes the far face from behind — a
back face — and gets discarded. Zero intersections, hence the message.

Fix: the model material is now `DoubleSide`. That's not a rendering preference, it's a
correctness requirement for any ray cast from inside the mesh, and it also rescues STLs
with inconsistent winding.

Also made exit selection principled: pick the first hit whose face normal points *along*
the ray (a genuine exit) rather than simply the last hit, which lands somewhere unrelated
on models with internal structure.

Verified against the real token: `FrontSide` → 0 hits; `DoubleSide` → exit at z=0.001 with
normal (0,0,-1), the bottom face.


### 2026-08-10 — Phase 2b: part mode, precision placement, asset library

Ian's first substantive UX review. Two items were architectural, the rest mechanical.

**The architectural finding: paint alone isn't enough.** Ian wanted to select decals with
PrusaSlicer's smart fill / bucket fill and reassign toolheads from the object tree. Neither
is possible with MMU paint, and not because of a bug: smart fill walks connected facets
bounded by sharp edges, and painted regions have no edges — they're per-triangle metadata,
not geometry. Same reason they never appear as parts.

He also reported colour reaching too deep in the sliced result, which paint mode can't
control: the slicer decides how far segmentation propagates inward.

**Both are solved by the same change — a second output mode.** `parts` extrudes each SVG
into a prism (SVGLoader → shapes → ExtrudeGeometry, so fill rules and holes are handled)
and embeds it just under the surface, top face 0.01mm proud to avoid coplanar ambiguity.
PrusaSlicer unions part volumes with their object and the part's extruder wins in the
overlap, giving flush colour, an entry in the object tree with a toolhead dropdown, working
smart fill, and colour depth equal to the prism thickness — configurable, default 0.6mm.

Paint mode is kept and remains the better answer for awkward surfaces and for leaving the
mesh untouched. Mode is chosen at export.

**3MF writer rewritten for multiple volumes.** PrusaSlicer represents a multi-part object
as one merged mesh plus `firstid`/`lastid` spans in `Slic3r_PE_model.config`. An off-by-one
there silently assigns the wrong toolhead to the wrong geometry, so 27 tests now cover span
tiling, empty-volume skipping, cross-volume vertex welding, paint attributes and XML
escaping.

**Placement precision:**
- Arrow-key nudge with selectable step (0.01 / 0.1 / 1 / 5 mm), re-projected onto the
  surface after each move so the decal stays stuck to curved geometry
- Align buttons — centre, h-centre, left, right, top, bottom — computed against the model's
  bounding box as seen from the decal's own viewing direction, so "centre" on a token face
  means the centre of the token
- **Copy to opposite face**: raycasts straight through to the far surface and duplicates
  there with the artwork flipped, for coins and two-sided tokens
- Manual flip-horizontally toggle

**Library and inputs:**
- SVG library persists for the session with thumbnails; arm any asset and place it
- Multi-file SVG import; assets removable (taking their decals with them)
- Model removable and replaceable; replacing clears decals, undoably, since positions are
  model coordinates
- Type-in numeric fields alongside every slider
- New decals inherit the last width and toolhead instead of resetting
- **Removed the toolhead auto-cycling** — Ian wants to assign them himself

**Preview fix:** decals are textured with a white silhouette rather than the raw artwork.
Tinting multiplies into the texture, so a black logo previewed black regardless of toolhead.

180 tests, typecheck clean.


### 2026-08-10 — Phase 2a: placement UX

Ian chose placement UX as the Phase 2 priority, with curved surfaces second ("mix of
both" — worth having, not urgent).

- **Multiple decals per model.** `stampLayers()` paints any number of decals in one pass.
  Overlaps resolve last-wins. Doing it in one pass rather than merging per-decal results
  avoids reconciling two subdivision trees over the same triangle, which is fiddly and
  lossy — a single classifier consulting layers in order is simpler and exactly right.
- **Real surface-conforming preview** via Three's `DecalGeometry`, replacing the floating
  quad. It clips actual geometry to the projector box and hugs the surface, so curvature
  and silhouette read correctly. Decals are tinted with their toolhead's Prusa colour.
- **Drag to move.** Grab a decal on the model and it follows the surface, re-deriving its
  normal as it goes. One undo step per gesture, not per frame.
- **Undo/redo** with Ctrl+Z / Ctrl+Shift+Z and buttons. History snapshots a small
  serializable decal array; heavy assets (masks, canvases) live in a separate registry
  keyed by id, so undo never copies pixels.
- **Decal list** with selection, per-decal toolhead, and delete. New decals auto-pick an
  unused toolhead so overlapping decals stay distinguishable.
- Export refuses when any decal shares the model's toolhead, listing how many.
- Preview box depth is capped against the model's smallest dimension, so a 2mm token
  doesn't get a decal projected onto its underside.

`src/app/decals.ts` is deliberately free of Three.js and DOM references so the store and
its history are unit-testable. 25 new checks; 136 total.

**Note on local tooling:** `node_modules` in the working folder is a Windows install, so
`vite build` can't run in the Linux sandbox (rollup ships platform-specific native
binaries). `tsc` and the tests run fine, and CI installs fresh on Linux.

### 2026-08-10 — Phase 1 complete. Fix verified on hardware-real workflow.

- **Open edges confirmed fixed.** Ian re-tested after a hard refresh: no open-edge
  warning, no repair prompt, paint intact. The first "still broken" report was a cached
  page serving the pre-fix bundle.
- **Anti-staleness measures added** so that can't recur: a build version string shown in
  the panel and in the export status line, and exported filenames now carry the toolhead,
  detail setting and a timestamp (`token-th2-0.2mm-143052.3mf`) instead of a single
  overwriting name.
- **Verified our writer independently** by running Ian's real STL through the full export
  path headlessly: 56 vertices, 108 triangles, every edge used exactly twice, 0 open edges.
  The source STL was also confirmed flawless at every rounding tolerance, so neither end
  was ever at fault once pre-subdivision was removed.

**Finding: the Detail setting is nearly vestigial, and that's correct.** Ian sees no visual
difference across the range. Expected: 0.2mm and finer are all below what a 0.4mm nozzle
resolves, so the only setting that could plausibly show a difference is 0.4mm versus the
rest, and only on hairline strokes. The binding constraint is the printer.

Implication: **0.2mm is the right default and there is little reason to change it.** The
0.05mm option exists mainly to demonstrate the ceiling. Candidate simplification later:
collapse to two options, or hide it behind an "advanced" toggle. Not urgent — it costs
nothing and the note under the dropdown explains it.

### 2026-08-10 — Two serious bugs found by real-world testing and fixed

Ian's first real run surfaced two defects, one visible and one silent.

**Bug 1 — open edges / destroyed paint (critical).** Exports had 144 open edges. PrusaSlicer
demanded an STL repair, and repairing rebuilt the mesh and wiped the paint, leaving a blank
model. **Cause: our own geometry pre-subdivision.** Subdividing triangles inside the decal
footprint but not their neighbours creates T-junctions — the new midpoint vertices don't
exist on the adjacent un-subdivided triangles. Measured on the hexagon token: 0 open edges
before, 108 after.

**Fix: never modify the mesh.** PrusaSlicer's segmentation tree is *virtual* — applied at
slice time, geometry untouched. That's the whole point of painting versus embossing, and
pre-subdivision was solving a problem that didn't exist while creating one that did. Risk 2
(T-junctions) is now retired by construction rather than mitigated.

**Bug 2 — all Detail settings looked identical (silent).** Two independent causes:

1. Every preset was already past the printer. Effective resolutions were 0.25 / 0.0625 /
   0.0156 / 0.0039 mm against a 0.4mm nozzle. All four were far below what FDM can render,
   so of course they looked the same.
2. **A decal smaller than a triangle was silently dropped entirely.** `buildTree` stopped
   recursing as soon as its four sample points agreed. For a small decal in the middle of a
   large triangle, all four samples land outside the artwork, all agree on "unpainted", and
   recursion never begins. Sampling can never prove a region is empty — only that the
   samples missed it. Pre-subdivision had been masking this by forcing triangles small
   enough that the samples caught the mask.

**Fix:** subdivision is now unconditional to a depth derived per triangle from a target
feature size in mm, with a conservative region-level early-out (region entirely outside the
decal rectangle → no paint possible). Cost now scales with decal area, not mesh size.

Detail is expressed in millimetres rather than as an abstract quality level. Measured on the
token: 0.4mm → depth 4 / 1.1KB, 0.2mm → depth 5 / 2.5KB, 0.1mm → depth 6 / 5.9KB, 0.05mm →
depth 7 / 12.3KB. Zero open edges at every setting, 15–53ms.

**Also confirmed working:** toolhead assignment is correct in PrusaSlicer.

**Tests added:** watertightness preservation on a closed cube; a decal much smaller than a
triangle; a hairline stroke through a triangle's middle; per-triangle depth derivation.
32 stamp checks, 76 codec checks.

**Calibration reference** from Ian's hand-painted file: PrusaSlicer's own brush produces
trees 4–5 deep (≈0.195mm on 6.25mm triangles) and leans heavily on partial splits — 246
four-way, 108 three-way, 37 two-way. We emit only four-way, which is fine now that the tree
is virtual: mismatches between neighbours are cosmetic at sub-resolution scale rather than
geometric.

### 2026-08-10 — Shipped. Repo public, CI green, app live

- **Pushed to https://github.com/imcg1122/SVGMesh** and deployed to
  **https://imcg1122.github.io/SVGMesh/** via GitHub Actions.
- **CI debugging.** First run failed in 12s. Diagnosed through GitHub's public REST API
  (`/actions/jobs/<id>` gives per-step conclusions without auth — useful trick, the Chrome
  extension wasn't connected). `npm ci` and all 96 tests passed on the runner; only
  `tsc --noEmit` failed, with 5 errors:
  - `process.env` in `vite.config.ts` without `@types/node` → removed the env lookup
  - hand-written `three-mesh-bvh` module augmentation collided with the library's own →
    deleted the `.d.ts` and cast at the patch site instead, which survives version drift
  - `process.exit()` in the two test files → added `@types/node`
- **Build no longer runs `tsc`.** Vite strips types with esbuild and never type-checks, so
  gating the build on tsc bought nothing; the `test` job owns typechecking and blocks
  deployment on it.
- **Windows setup notes** (worth keeping for future machines): PowerShell blocks `npm.ps1`
  under the default `Restricted` execution policy — fix with
  `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`. Git is unaffected
  since it's a real `.exe`.
- **Repo description set** by Ian: "Allows for easily adding in SVG stamps to STL files for
  multi color prints in prusaslicer".

### 2026-08-09 — Phase 0 closed; repo scaffolded; MVP built

- **Mapping resolved: direct, state N → extruder N.** The toolhead probe showed patch 2 on
  TH2, and Ian confirmed the blob was painted with TH2. There was no encoder bug — see §4.
  Root cause of the confusion: five identical filament colours, plus state 1 being
  invisible over an extruder-1 body.
- **Phase 0 closed.** Both directions of the format are now validated against real
  PrusaSlicer 2.9.6 output.
- **Repo scaffolded and committed locally** (23 files, ~2,900 lines). Remote set to
  `imcg1122/SVGMesh`. Not pushed — no credentials in the sandbox.
- **Ported the codec to TypeScript** (`src/mmu/codec.ts`) with 76 tests, including the 30
  real PrusaSlicer strings as permanent regression fixtures. Added state remapping, needed
  whenever extruders are renumbered.
- **Built the stamp engine** (`src/paint/stamp.ts`): planar projector, UV mapping, back-face
  and grazing-angle culling, adaptive pre-subdivision to a target edge length, then quadtree
  refinement. 20 headless tests.
- **Built SVG rasterization, STL reading, 3MF writing, and the MVP app** — load STL, load
  SVG, click to place, size/rotate, pick toolheads, export.
- **Guard added:** export is blocked when the decal and base share a toolhead, since that
  silently produces nothing visible.
- **Tooling note:** npm registry is blocked in the sandbox, so dependencies are unverified
  by install. Tests deliberately use Node 22's native type stripping and need no packages,
  so they run anywhere. `npm run typecheck` still needs a local install.
- Added a GitHub Actions workflow: test → typecheck → build → deploy to Pages.
- Test assets gitignored (third-party artwork, regenerable binaries).

### 2026-08-09 — Ground truth validated; mapping bug suspected; scope narrowed

- **Decoder validated against real PrusaSlicer output.** Ian's `painted blob test.3mf`
  (PrusaSlicer 2.9.6, XL5IS) decodes cleanly: 30/30 painted triangles, byte-for-byte
  idempotent re-encoding. The format understanding is correct.
- **Encoder bug surfaced.** Ian's read of the test cubes implies a one-off shift in the
  state → toolhead mapping, contradicting Panda2Prusa's documented direct mapping. Built
  `phase0/make_toolhead_probe.py` → `toolhead_probe.3mf` to settle it with a single
  observation.
- **Found a profile gotcha:** all five of Ian's `filament_colour` entries are `#FF8000`,
  making toolheads visually identical in the 3D view. Likely contributed to the confusing
  read. Flagged in §4.
- **Variant B wins.** Ian confirms pre-subdivided geometry is visibly smoother than a deep
  quadtree on coarse geometry. Pre-subdivision is now the primary quality lever.
- **Scope narrowed — no freehand painting.** Ian clarified the goal is better SVG
  placement/manipulation, not a painting tool. Brush/eraser dropped from v1. Decals should
  be live and re-editable.
- **Adopted Mesh Graffiti as the UX reference target** and recorded a feature-by-feature
  stance (§3).
- **Studied Panda2Prusa.** Independent implementation of the same bitstream; confirms the
  grammar, the 18-state ceiling, and that Bambu's `paint_color` is the identical format.
  Its renumbering logic will matter when we let users reassign toolheads after the fact.
- **Risk raised:** real PrusaSlicer output leans heavily on 2-way and 3-way partial splits,
  which our generator doesn't yet emit.
- Test assets received: hexagon token STL and cutlery SVG.
- Repo named: `imcg1122/SVGMesh`.

### 2026-08-09 — Project kickoff, Phase 0 codec built

- Researched prior art. PrusaSlicer's SVG emboss covers placement/scale/wrap/extruder but
  only by adding geometry. No free local tool does SVG → MMU paint data.
- Confirmed the MMU segmentation format is publicly documented — retired the single largest
  feasibility risk.
- **Decided:** client-side browser app, no cloud, Three.js stack, GitHub Pages hosting.
- **Decided:** Phase 0 scripts in Python (stdlib only); app in TypeScript.
- Built `phase0/mmu_codec.py`, `phase0/test_codec.py` (all pass, incl. reference vector
  `48403`, extended states, partial splits, pruning, malformed-input rejection), and
  `phase0/make_test_3mf.py` (Variants A and B).
- Set up `CLAUDE.md`; folded the original `PROJECT-PLAN.md` into this file and deleted it.
