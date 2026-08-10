# Working agreement for this project

## Standing instruction — the living project plan

`projectplan.md` in this folder is the **single source of truth** for this project. It is a living document.

**At the start of any session:** read `projectplan.md` first to recover context.

**During and at the end of any session:** update it. Do not wait to be asked. Specifically keep current:

- **Status** — where we actually are right now
- **Goals** — what we're building and why
- **Next steps** — the immediate actionable items
- **Blocked / needs from Ian** — anything waiting on him
- **Changelog** — dated, append-only record of what changed and what was decided

Update it when something is finished, when a decision is made, when a risk is discovered or retired, and when direction changes. It should be possible to hand this file to someone cold and have them understand the project.

`PROJECT-PLAN.md` (uppercase, hyphenated) was the original one-off plan and has been folded into `projectplan.md`. Do not recreate it.

## Project one-liner

MeshStamp — a browser app that projects SVGs onto STL surfaces as PrusaSlicer MMU paint data (not geometry) and exports `.3mf` with toolheads pre-assigned for Ian's Prusa XL 5-toolhead.

## Conventions

- Client-side only. No server, no cloud. GitHub Pages + offline PWA.
- Vite + TypeScript + Three.js. `three-mesh-bvh`, `three-bvh-csg`, `fflate`.
- Phase 0 validation scripts are Python (fast to iterate, stdlib-only); the app itself is TypeScript. The codec logic is ~60 lines and ports trivially.
- Ian's preference: concise and direct. Skip the preamble.
