# GTATHENS project board

GitHub Projects Kanban for collaborators. Create it via:
`gh project create --owner <org-or-user> --title GTATHENS` then add the views/fields below
(or import via Settings → Projects → New project → `+` → use this file as the spec).

## Columns (Status field)

| Column | Meaning | WIP limit |
|---|---|---|
| Backlog | ideas, not yet shaped | — |
| Ready | well-scoped, has acceptance criteria, anyone can pick up | — |
| In Progress | actively being worked (1 issue per person) | 1/person |
| In Review | PR open, needs reviewer | — |
| Done | merged + verified (smoke green) | — |

## Views

- **Board** (default): group by `Status`.
- **By area**: group by `Area` (player / cars / peds-traffic / weapons / world-city / audio-ui / infra).
- **Current sprint**: filter `Milestone = v0.2-collab`.

## Labels

`good first issue` · `bug` · `feature` · `infra` · `docs` · `perf` · `needs-repro` · `blocked`

## Starter issues (create these first — titles + bodies ready to paste)

### 1. [docs] Confirm asset licenses before public launch
**Labels:** docs · **Area:** infra
**Body:** Verify Kenney + Rgsdev + OSM attribution in README matches upstream license texts (`src/assets/.../License.txt`). Add `ATTRIBUTION.md` if anything is missing.
**Accept:** `ATTRIBUTION.md` exists or README confirmed sufficient.

### 2. [infra] CI green on fresh clone (Windows + Linux)
**Labels:** infra, good first issue · **Area:** infra
**Body:** `npm ci && node scripts/parse-check.mjs && npm run build` passes on a clean checkout. Report OS/Node versions in a comment.
**Accept:** comment with green logs from 2 machines.

### 3. [bug] Smoke test passes end-to-end on a contributor machine
**Labels:** bug, good first issue · **Area:** infra
**Body:** Follow `AGENTS.md` "Running the game headlessly": launch dev server, run `node scripts/smoke.mjs http://127.0.0.1:5173/ 10 6`, paste the report. File sub-issues for any FAIL section.
**Accept:** full report pasted; PASS on movement + car enter/exit + crash + shooting, or sub-issues filed.

### 4. [feature] On-foot gamepad parity check
**Labels:** feature · **Area:** player
**Body:** Verify `src/lib/gamepad.js` mapping on a real pad: LS move, RS look, A jump, X/LT enter, Y char, LB/RB run. Fix dead zones/edges found.
**Accept:** checklist in PR verified on hardware.

### 5. [feature] AI traffic density + perf budget
**Labels:** feature, perf · **Area:** peds-traffic
**Body:** Profile 5 AI cars + 10 peds (`H` overlay + `window.__gtathensStats`). Try raising counts; record FPS/calls/tris. Keep 60fps on reference machine or gate behind quality setting.
**Accept:** numbers posted; no regression vs `main`.

### 6. [feature] Weapon feel pass (recoil/spread/ammo economy)
**Labels:** feature · **Area:** weapons
**Body:** Tune `src/lib/weapons.js` + `WeaponController.jsx` two-stage aim (camera ray → aim point → muzzle ray; do NOT collapse to one stage — see AGENTS.md). Keep `SHOOT TEST` green.
**Accept:** smoke `SHOOT TEST: PASS`, notes on tuning posted.

### 7. [feature] Minimap / wanted-level prototype
**Labels:** feature · **Area:** audio-ui
**Body:** Prototype a canvas minimap from `map_data.json` + road graph; sketch wanted-level rules in the store (no persistence yet).
**Accept:** screenshot/gif in PR; behind a flag if unfinished.

### 8. [infra] Fresh-clone smoke for `map_data.json` regeneration
**Labels:** infra · **Area:** world-city
**Body:** `python parse_map.py` reproduces `map_data.json` byte-identical (or documents the diff). Pins REF_LAT/REF_LON sync with `src/lib/geo.js`.
**Accept:** repro steps + hash posted.
