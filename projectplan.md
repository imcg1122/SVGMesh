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
| **Phase** | 1 — MVP app |
| **Phase 0** | ✅ **CLOSED.** Format fully validated in both directions. |
| **Decoder** | ✅ 30/30 real PrusaSlicer 2.9.6 triangles parse and re-encode byte-for-byte |
| **Encoder** | ✅ Accepted by PrusaSlicer. **Mapping confirmed direct: state N → extruder N.** No bug — the original confusion was five identically-coloured filaments. |
| **Repo** | Initialized and committed locally. 23 files, 96 tests passing. **Not yet pushed** — needs Ian's credentials (§7). |
| **Blocked on** | Ian to push, then run the MVP against the hexagon token + cutlery icon |

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

**① Push the repo.** It's committed locally with the remote already set, but the sandbox
has no GitHub credentials so the push has to come from Ian's machine:

```
cd "<this folder>"
git push -u origin main
```

**② Run the MVP** and report what it does with the real assets:

```
npm install
npm run dev
```

Load `blank small hexagon token.stl`, load `food-restaurant-icon.svg`, click the token's
top face, set width ~15mm, decal toolhead 2, export, open in PrusaSlicer.

The interesting question is **edge quality on the cutlery icon's thin strokes** at each
Detail setting. That's the last unretired risk. Note the token is only 2mm tall, so the
icon has to land on the top face — a side face has almost no area.

**③ Enable GitHub Pages** once pushed: repo Settings → Pages → Source: GitHub Actions. The
workflow in `.github/workflows/deploy.yml` runs tests, then builds and deploys on every
push to `main`. `vite.config.ts` has `base: '/SVGMesh/'` to match the repo name.

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

**1. Edge crispness — still the big one.** Ian confirms Variant B (pre-subdivided geometry,
shallow tree) is *definitely smoother* than Variant A (coarse geometry, deep tree), despite
similar leaf counts. **Decision: pre-subdivision of the footprint is the primary quality
lever, not tree depth.** Still needs a real-logo test before it's retired.

**2. T-junctions / partial splits — risk raised.** Ian's ground-truth file uses 2-way and
3-way splits heavily (nibbles `1`, `5`, `6`, `A` appear throughout), confirming PrusaSlicer
relies on them to keep adjacent triangles consistent. We currently emit uniform 4-way
splits only. Our codec already supports partial splits, but the *generator* doesn't use
them. If boundary artifacts show up, this is the fix.

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
