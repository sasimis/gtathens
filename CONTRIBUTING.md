# Contributing to GTATHENS

Welcome! This guide gets new collaborators shipping in < 30 minutes.

## 1. Setup

```bash
git clone <repo-url> gtathens
cd gtathens
npm install
npm run dev     # http://127.0.0.1:5173/ → click PLAY
```

Prereqs: Node 20+, Git. No other services needed.

## 2. Branch workflow

- Default branch: `main` (protected — PRs only, CI must pass).
- Branches: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
- Keep PRs small and focused; one system per PR.
- Every PR must pass `node scripts/parse-check.mjs` + `npm run build` (CI runs both).

```bash
git checkout -b feat/my-feature
# ... edit, verify ...
node scripts/parse-check.mjs
npm run build
git push -u origin feat/my-feature
# open PR against main, link the board issue (Fixes #N)
```

## 3. Code conventions (must-read — violations cause black screens)

Read `AGENTS.md` at repo root before touching code. Highlights:

- **zustand v5:** one primitive per selector (`useGameStore((s) => s.phase)`). Never return an object literal from a selector.
- **Inside `<Canvas>`:** never render DOM (`div/span/img`). Overlays live in `src/ui/`, painted imperatively.
- **Physics:** Rapier `setBodyType` takes a numeric enum (`0=Dynamic,1=Fixed,…`) — never a string. Use `setRigidBodyType` from `car-modules/crashManager.js`.
- **Colliders:** `ConvexHullCollider` needs a flat `Float32Array`, de-duped, area-guarded. Verify with `node scripts/hull-repro.mjs`.
- **No per-frame allocation** in `useFrame` — reuse scratch objects.
- World units = meters; north = `-Z`, east = `+X`. Keep `REF_LAT/REF_LON` in `parse_map.py` in sync with `src/lib/geo.js`.

## 4. Project board

We use a GitHub Project (Kanban): **Backlog → Ready → In Progress → In Review → Done**.
Pick an issue from **Ready**, move it to **In Progress**, open a PR to move it to **In Review**.
See `docs/PROJECT_BOARD.md` for columns, labels, and WIP limits.

## 5. Tests / verification

```bash
node scripts/parse-check.mjs
node scripts/hull-repro.mjs
node scripts/navmesh-repro.mjs
node scripts/roadpath-repro.mjs
# full headless playthrough (~50s, needs dev server running):
npm run dev &
node scripts/smoke.mjs http://127.0.0.1:5173/ 10 6
```

A healthy smoke report: `canvas:true`, `bodies:44`, `colliders:448` after PLAY,
~57–60 fps, `uncaught exceptions: none`, HUD like `DIMITRI 08:07 $0 100 Fists`.

## 6. Reviews

- At least 1 approval; author merges with squash.
- Link smoke/parse output in the PR body for gameplay changes.
- Be kind — comment on code, not people.
