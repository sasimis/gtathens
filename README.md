# GTATHENS — Athens Low-Poly Open World

Low-poly GTA-style open world set in Athens.
React + Vite + react-three-fiber + drei + Rapier. World units are meters (1 unit = 1 m); north = -Z, east = +X.

## Quickstart

```bash
npm install
npm run dev      # Vite dev server (http://127.0.0.1:5173/)
npm run build    # production build (~2892 modules, clean)
```

Map data: `REF_LAT`/`REF_LON` in `parse_map.py` must stay in sync with `src/lib/geo.js`.

## Controls

- **On foot:** WASD move (W = camera-forward), mouse drag look, `1/2/3` camera presets, `V` cycle camera, `F` enter car, `X` fire, `R` reload, `Q/E` cycle weapons, `I` inventory, `H` stats, `G` collider wireframes
- **Driving:** `W/S` throttle/brake, `A/D` steer, `F`/`B` exit, gamepad RT/LT pedals + LS steer supported
- **Menu:** click PLAY to spawn

## Verification (run from repo root)

```bash
node scripts/parse-check.mjs            # Babel-parses all src/**
node scripts/hull-repro.mjs             # convex-hull collider path in Node
node scripts/navmesh-repro.mjs          # navmesh module in Node
node scripts/roadpath-repro.mjs         # road pathfinder in Node
node scripts/smoke.mjs <url> <bootSecs> <playSecs>  # boots the real game in headless Chrome over CDP
```

See `AGENTS.md` (project root) for the full agent handbook: architecture map,
gotchas (zustand selectors, Rapier body-type enum, muzzle parenting, hit-test
heights, …), QA hooks (`window.__gtathens*`), and the headless smoke-test guide.

## Collab

- `CONTRIBUTING.md` — branch / PR / board workflow
- `docs/PROJECT_BOARD.md` — board columns + starter issues for new collaborators
- CI: `.github/workflows/ci.yml` runs parse-check + build on every PR

## Assets / credits

- Buildings/character: Kenney packs (see `public/models/kenney/`)
- Cars: Rgsdev free low-poly pack (`public/models/cars/*.fbx`, UNIT 0.01) — check `License.txt` in `src/assets/`
- Map: OpenStreetMap extract (`map.osm` → `map_data.json` via `parse_map.py`)
