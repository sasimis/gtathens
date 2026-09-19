# GTATHENS — agent codebase notes

Low-poly GTA in Athens (React + Vite + react-three-fiber + drei + Rapier).
World units are meters (1 unit = 1 m); north = -Z, east = +X
(see `src/lib/geo.js` — must stay in sync with REF_LAT/REF_LON in `parse_map.py`).

## Run / build

- `npm run dev` (Vite), `npm run build` (`vite build`, ~2892 modules, clean).
- Workspace root: `workspace/` (this file lives at the project root next to it).
- Verification scripts (run from `workspace/`): `node scripts/parse-check.mjs`
  (Babel-parses all `src/**`), `node scripts/hull-repro.mjs` (convex-hull
  collider path in Node), `node scripts/smoke.mjs <url> <bootSecs> <playSecs>`
  (boots the real game in headless Chrome over CDP — see below).
- When checking a build from PowerShell, redirect through `cmd /c "... > out.txt 2>&1"`
  and read `$LASTEXITCODE`; Vite's yellow chunk-size advisory hits PowerShell's
  stderr as a fake `NativeCommandError`.

## Big files / systems

| Area | File | Notes |
|---|---|---|
| Boot / canvas / ground | `workspace/src/App.jsx` | Canvas DPR + fog by quality; ground top face exactly y=0. `H` stats strip, `G` collider wireframes (`<Physics debug>`). |
| Pavement | `workspace/src/components/Ground.jsx` | One 4000 m box, top face exactly y=0 (so it IS the collider). Texture = the EXACT reference photo `public/textures/tiles.jpg` (1600², a 4×4 grid of faceted off-white pillow slabs = 2 m slabs at `TILE_M = 8`, repeat 500×500, sRGB + aniso 8). Loaded imperatively (not `useTexture`) so a missing file degrades to a flat grey plaza instead of a black canvas. **Used as-is — never re-bake/recreate it procedurally; swapping the plaza = replacing that one image.** |
| Store | `workspace/src/store/useGameStore.js` | `Phase` machine, `spawn`, `character`, `driving` (car index or null), `nearCar`, `respawn` (exit-car handoff), `gameTime` (~4 Hz writes), `camView` 0/1/2 + `setCamView`/`cycleCamView`, `CAM_VIEWS` presets. Persisted: settings only (`gtathens-v2`). |
| On-foot player | `workspace/src/components/Player.jsx` | Capsule (half 0.6 + r 0.35 = 1.9 m, center y 0.95, model feet at collider bottom). **W = camera-forward, S = back, A/D = strafe + slight turn** (faces move dir, strafe leans ≤ ~35°). `CarEntrance` polls `useParkingSpots` every 100 ms with hysteresis (enter 3.4 m, keep 4.2 m) → stable `nearCar` / F prompt + re-entry. |
| Camera | `workspace/src/components/FollowCamera.jsx` | Fixed presets only (Near 5.5 m / Std 8.5 m / Far 12.5 m). Keys **1/2/3** jump, **V** cycles, vertical drag = pitch trim, wheel ignored. `CameraRig` raycasts head→goal (3-arg castRay, 0.4 m self-guard, min 1.2 m shoulder-cam, floor ≥ 0.7 m). |
| Cars | `workspace/src/components/car-modules/*` (barrel: `Car.jsx`) | KayKit GLB pack (`/models/cars/*.glb`, meters, showroom XZ offsets re-centered by `CarModel`; materials cloned + `metalness` zeroed + array-shape preserved — see gotchas). Split into `constants.js` (IDs/HALF/groups/tuning) · `crashManager.js` (`crash` singleton = bodies/livePos/damage/loose + `setRigidBodyType`) · `Car.jsx` (+`CarModel`) · `CarDriver.jsx` (+`LooseSettler`) · `ParkedCars.jsx` · `useParkingSpots.js` · `utils/{polygon,misc}.js`. **`components/Car.jsx` is now a compat barrel (+ `CarModel`) — the real code lives in `car-modules/`.** `useParkingSpots` = deterministic layout shared by renderer + enter detection. Collision groups are two-sided: cars accept ground+player+car+building, player accepts all. `CarDriver` forces lin/ang vel (kinematic arcade), gamepad RT/LT/A/stick + B exit, asphalt-vs-grass speed split (`isOnAsphalt`). **Car-vs-car crashes**: parked cars knock loose (fixed→dynamic in place) on impact + take `crash.damage` (dents/scorch visuals, HUD `DMG` chip while driving, engine/steering penalty); `LooseSettler` re-freezes settled cars. QA hook `window.__gtathensCars` (`.ram(i)`, `.btype(i)` — drives/verifies the smoke test; `.spot(i)` includes the car `id`). |
| Buildings | `workspace/src/components/City.jsx` | Kenney GLB pools via `<Merged>` (module-level cache — never rename per render). Colliders = **ConvexHullCollider per RENDERED-model silhouette** (`xzHull` of the model's real XZ vertices, mapped through the exact mesh transform `T*R*S` incl. the 0.94 fit shrink) — collision lands ON the visible walls, NOT the OSM outline (kept only as fallback) or bbox. `hullVerts()` builds a **flat `Float32Array`** + rejects degenerate rings (see gotcha). `planBuildings` keeps `footprint` (world silhouette) + `colH` (real rendered height, `meta.h * sy`). |
| Character | `workspace/src/components/Protagonist.jsx` | Kenney FBX 1.8 m, feet local 0. Anim mixer: idle pre-posed at full weight (no T-pose flash), 0.25/0.30 s crossfades, mixer step clamped ≤ 0.05. Root motion stripped (physics owns translation). |
| Light / shadows | `workspace/src/components/DayNightCycle.jsx` | 48-min cycle, HUD clock throttled. **Tight 120 m shadow box that follows the camera target** (`shadowFocus` lerp) + `normalBias 0.6` = smooth shadows. Wide boxes = blocky/gonky. |
| HUD | `workspace/src/ui/Hud.jsx` | Char chip + GTA clock (HH:MM) + F prompt only. No brand chip, no camera buttons (keys 1/2/3/V). |
| Input (shared) | `workspace/src/lib/gamepad.js` | W3C standard mapping: `getGamepad`, `readStick` (dz 0.18), `padValue`/`padHeld`, `padEdge` rising-edge. On foot: LS move, RS look, A jump, X/LT enter, Y char, LB/RB run. Driving: RT/LT pedals, LS steer, A brake, B exit. |
| Roads | `workspace/src/components/Roads.jsx` | OSM ribbons merged per bucket (3 draw calls). Visual only (no colliders, ground plane is the floor). |
| Nav: peds | `workspace/src/lib/navmesh.js` + `src/components/CityNavMesh.jsx` | recast-navigation-js (WASM Recast/Detour). One city tile (~440 m, ground + 198 building prisms from OSM outlines via `buildNavGeometry`, ~2.5k polys, ~1 s one-time) built on mount, published through the STABLE `navRuntime` object (mutated in place, never reassigned) that `Ped` reads per frame; `window.__gtathensNav` QA seam. Building interiors are sealed by `pushPrism`'s `floorCap` (FLOOR_CAP_H=1.0 — too low merges into the walkable floor, see T5). Fails soft: if wasm/data fails, `navRuntime.ready` stays false and peds wander blind. Harness: `node scripts/navmesh-repro.mjs` (runs the REAL module in Node). |
| Nav: cars | `workspace/src/lib/RoadPathfinder.js` | A* over the OSM drivable graph (buildSegments → junction nodes → edges; ways that DON'T share nodes are stitched by `STITCH_R = 8.0` — measured, see gotcha). `getRoadPathfinder(data, filter)` WeakMap-caches one instance per (data, filter); `findPath` (A*, binary heap, partial-route fallback), `randomRoute(seed)` closed loops for AI traffic, `sampleRoute` (arc-length walking + yaw). AI cars in Npcs.jsx route with `randomRoute` (legacy random-walk kept as fallback). Harness: `node scripts/roadpath-repro.mjs`. |
| Aim | `workspace/src/components/WeaponController.jsx` | Two-stage aim: camera ray finds the aim POINT, the hit ray fires from the muzzle TOWARD it (see gotcha). `scripts/rayprobe.mjs` boots the game headless and casts rays at a live ped — the capsule IS hittable (toi 2.65 from 3 m); any "bullets pass through peds" report is an aim-geometry bug, not a collider one. |
| Debug | `workspace/src/components/DebugOverlay.jsx` | `H` stats (FPS/calls/tris/geo/tex/heap/bodies/colliders), `G` hitboxes, `window.__gtathensStats` + `window.__gtathensDebug.toggle()/colliders()`. |
| Guns | `workspace/src/components/WeaponController.jsx` | Owns firing/ammo/reload/switch. **Must be a CHILD of the model group** (see gotcha). Keyboard X fire / R reload / Q,E cycle / I inventory, LMB fire, pad RT fire + LB reload + RB run. Ray from the gun's `muzzle` (fallback: camera) via `rapier.Ray` + `world.castRay`, `res0.toi ?? timeOfImpact`. Peds are hit-tested by proximity (< 1.6 m) to the ray IMPACT point. Reload bar is DOM (`#gtathens-reload`), painted imperatively. |
| Gun model | `workspace/src/components/Weapon.jsx` | `buildGunModel()` (lib/weapons.js) = procedural boxes/cylinders, muzzle `<Object3D name="muzzle">` marker, `GunMount` (character hand position, recoil decay), `WeaponModel` (floating pickup). |
| Bullets | `workspace/src/components/BulletFx.jsx` | Fixed mesh pool + trail, mutated in place by `fireTracer()` / `muzzleFlash()` / `impactFlash()` — no per-shot allocation, never re-renders. |
| Pedestrians / traffic | `workspace/src/components/Npcs.jsx` | 10 kinematic peds (capsule, wander along WALKABLE ways, sidewalk offset, building reject) + 5 AI cars (box bodies looping the road graph, braking for the player). HP lives on `NPC_RECORDS` (module state); death = sink + `spawnDrop()` + toast. Rebuilt from empty in one session — see the traps below. |
| Pickups / economy | `workspace/src/components/Pickups.jsx` | Deterministic layout on walkable ways (`staticCache`, same recipe as parking spots) + `spawnDrop()` drops from kills; auto-collect on proximity (1.6 m on foot, 2.6 m driving). `WeaponModel` for gun pickups. |
| Inventory HUD | `workspace/src/ui/Inventory.jsx` | `$` cash, HP bar, `N KO`, weapon chips with mag/reserve, toasts, hitmarker, damage flash, `I` panel with equip buttons, and the `#gtathens-reload` track. |
| Shared world data | `workspace/src/lib/worldData.js` | `loadWorldData()` (ONE fetch shared by NPCs/pickups), `buildSegments(data, filter)`, `buildRoadGraph(segments)` → `{nodes, edgeList}`, `roadPolyline`, `buildingPolygons`, `hash01`, `pointInPolygon`, `DRIVABLE` / `WALKABLE`. |

## Gotchas for next agents

- **zustand v5 has NO built-in shallow equality — an object-returning selector
  is an infinite render loop.** `useGameStore((s) => ({ phase: s.phase, ... }))`
  hands `useSyncExternalStore` a NEW snapshot object on every call, so React
  re-renders forever: `Error: Maximum update depth exceeded (react limits the
  number of nested updates to prevent infinite loops)` → the error boundary
  unmounts `<Canvas>` → **black screen the moment PLAY mounts the player**
  (`rootChildren:0, canvas:false` in the smoke report; the crash originally
  appeared in `WeaponController`, the only file that had the pattern). ALWAYS
  select one primitive per hook call (`const phase = useGameStore((s) => s.phase)`)
  or wrap with `useShallow`/`shallow`. Actions are stable refs — selecting them
  individually is free. The smoke report's `uncaught exceptions` section prints
  the exact component stack, which is how this was found.
- **A component that renders inside `<Canvas>` must never return a DOM host
  element.** `<div>`/`<span>`/`<img>` are not THREE objects: R3F throws
  `Div is not part of the THREE namespace! Did you forget to extend?` and the
  scene unmounts. `WeaponController` needed a reload bar → the bar lives in the
  DOM overlay (`ui/Inventory.jsx`, `#gtathens-reload`) and is painted
  imperatively via `setReloadUI()` — the same trick DebugOverlay uses for
  `#gtathens-debug`. Keep overlays outside `<Canvas>`; only *writes* cross the
  boundary.
- **`useKeyboardControls()` returns `[subscribe, getKeys]` — destructuring the
  first element as `keys` silently disables every key.** `const [keys] =
  useKeyboardControls()` then `keys.fire` is `undefined` forever, and because
  the subscribe function is a STABLE reference an effect keyed on it never
  re-runs (so it looks like "the code ran once and nothing happened"). Keyboard
  fire/reload/cycle in `WeaponController` were dead this way while mouse and
  gamepad firing worked. Fix: `const [, getKeys] = useKeyboardControls()` and
  POLL `getKeys()` in `useFrame` (the pattern PlayerBody/Protagonist use),
  updating a `prevKeys` ref for rising edges.
- **The gun must be a child of the character's model group.** `GunMount`'s
  `muzzle` marker is the origin of every shot ray, and `<WeaponController>` as a
  *sibling* of `<group ref={modelRef}>` (Player.jsx) put the gun at the SCENE
  ROOT: `gunFX.getMuzzle()` then resolved to the mount's LOCAL coordinates
  (~0.27, 1.05, 0.44) — `Object3D.getWorldPosition()` recomputes the chain, so an
  unattached subtree yields local-only numbers. Symptom: no gun visible on the
  character, and every bullet flies from the world origin, so shooting can never
  hit anything no matter where you stand (the smoke test caught it as
  `impacts: 26, hits: 0` with the impact point ~2 m from `(0,0)` while the
  player was 50 m away). Keep `<WeaponController>` INSIDE the model group;
  `BulletFx` stays outside (world-space pooled meshes).
- **Ped hit-tests must use the ped's capsule CENTER, not `y + 0.95`.** A ped's
  `RigidBody` sits at `y = 0.95` (capsule `args=[0.6, 0.35]`), so `bt.y` IS the
  chest height. Adding another 0.95 put the 1.6 m hit sphere at ~1.9 m — above
  the ped's head — so leg/ground impacts never registered and pedestrians looked
  invulnerable point-blank. The proximity test also only runs when the ray
  actually IMPACTED something (`if (hit)`), so a shot into empty sky is a miss by
  design.
- **`world.castRay` in the shooting path**: build the ray with
  `new rapier.Ray({x,y,z},{x,y,z})` (from `useRapier()`'s `rapier`, not
  `THREE.Ray`), always `ray.free()` it, and read `res.toi ?? res.timeOfImpact`
  (the compat build exposes both). Wrap the cast in try/catch — a bad ray traps
  WASM.
- **Reusing the pre-existing `window.__gtathensPickups` seam: MERGE, don't
  replace.** It is installed at module scope (with `remaining`/`list`/
  `tpNearest`), so a component effect that does
  `window.__gtathensPickups = {...}` clobbers it, and a cleanup that
  `delete`s the whole object removes it for good. Extend the existing object
  (`const qa = window.__gtathensPickups || (window.__gtathensPickups = {})`)
  and remove only your own keys.
- **Substring footguns when editing with `.Replace`**: replacing a 6-space
  indented line ALSO matches the tail of an 8-space indented line (the pattern
  is a substring), which silently mangled the model group's JSX — always count
  matches first, or anchor on both ends. (Related: the `editor` tool's writes
  were silently lost twice in this session — `Get-FileHash`/`Select-String`
  immediately after every edit, and prefer
  `[System.IO.File]::ReadAllText/WriteAllText` with an ABSOLUTE path: .NET uses
  the process CWD, not PowerShell's.)
- **Rebuilding `Npcs.jsx` from an empty file**: it imports
  `buildingPolygons/buildRoadGraph/buildSegments/DRIVABLE/hash01/loadWorldData/
  pointInPolygon/roadPolyline/WALKABLE` from `../lib/worldData` (check the real
  export list first — `pickGraphStart`/`roadWindows` never existed), `NPC_HP`
  from `../lib/weapons`, `spawnDrop` from `./Pickups`, `HALF` from `./Car`.
  `NPC_RECORDS`/`AI_CAR_STATE`/`NPC_KILL_TOAST`/`PED_COUNT`/`AI_CAR_COUNT` are
  imported by other modules — keep the names. A duplicated import block
  (`Identifier 'React' has already been declared`) and a truncated `Ped` JSX
  body were both tracked down via `node scripts/parse-check.mjs`.
- **Convex hull need a FLAT array — nested `[[x,y,z],...]` = black screen.**
  `ConvexHullCollider args={[verts]}` must be a flat `Float32Array`
  (`[x,y,z, x,y,z, ...]`). `@react-three/rapier`'s `scaleVertices()` assumes a
  flat buffer (`for (i < vertices.length / 3) scaledVerts[i*3] *= scale.x`), so a
  nested array gets walked `points/3` times and `[x,y,z] * 1` → **NaN**. The
  NaN reaches Rust, `ColliderDesc.convexHull()` → `intoRaw()` →
  `createCollider` panics with WASM `RuntimeError: unreachable`, React's error
  boundary unmounts `<Canvas>` and the user sees a **black screen** (empty
  `#root`, ~1 panic per building). Degenerate input panics too: zero-area
  (collinear) rings, duplicate or non-finite points. Always: flat array +
  de-dup + shoelace-area guard + rectangular fallback. Reproduce/verify with
  `node scripts/hull-repro.mjs`, which runs the real code path in Node.
- **A mesh with an ARRAY material and NO `geometry.groups` silently renders
  NOTHING.** three's `projectObject()` builds render items PER GROUP when
  `Array.isArray(material)` — empty `groups` → zero pushes, no error, no
  warning. The KayKit car GLB swap looked like "cars don't render" while
  physics, the F prompt and crash tests all passed (the meshes sat in the
  scene graph at the right spots, `visible:true`, correct NDC). `CarModel`'s
  clone step used to wrap the GLB's single material into `[material]`; it now
  PRESERVES the shape (`Array.isArray(o.material) ? map(fixOne) :
  fixOne(o.material)`). Prove either direction live with
  `scripts/probe-carviz.mjs` (boots the real game: GLB parse, scene census at
  the parking spots, live material/frustum dump, magenta-material A/B swap +
  screenshots). `SceneProbe` (App.jsx) publishes `window.__gtathensScene`,
  `__gtathensCam3` (live camera) and `__gtathensGl` (renderer.info) for it.
- **The KayKit car GLBs omit `metallicFactor` → glTF default 1.0 →
  `metalness: 1`** = full metal with no `scene.environment` to reflect →
  near-black paint against dark asphalt (looks "invisible" too).
  `CarModel` zeroes `metalness` and floors `roughness` at 0.55 on the cloned
  materials. Check any future GLB pack statically with
  `node scripts/glb-pbr.mjs` (dumps each GLB's PBR factors + root node
  transform from the JSON chunk, no browser needed).
- Rapier collides A↔B only if EACH side's filter accepts the other — when adding
  a group, update BOTH sides (this exact bug made cars ghost through players).
- **`rb.setBodyType('fixed')` silently makes the body DYNAMIC — the arg is a
  `RigidBodyType` ENUM, not a string.** `@react-three/rapier`'s JS wrapper passes
  the value straight to `Collider`/`RawRigidBodySet.setBodyType(handle, type)`,
  and `'fixed'` crosses into Rust as **0 = Dynamic** (`RigidBodyType` is
  `#[repr(u32)]`, `Dynamic = 0, Fixed = 1`); there is no string parser on the
  rapier side, only `rigidBodyTypeFromString` inside the r3f lib. Symptom: every
  parked car reports `body.isFixed() === false`, the crash gate in
  `crashHitFromPayload` (`if (!me.isFixed()) return`) can never fire, and the
  smoke test dies with `CRASH TEST: FAIL / damage=0.000` while the victim still
  visibly slides 11 m — it was a dynamic box the whole time. Same trap when a
  body is *created* with a string type via the React prop: csg's
  `setBodyType(type, awake)` also ends up on the enum path. Fix + always-verify:
  `crashManager.setRigidBodyType(rb, RB_FIXED)` (numeric `rb.setRigidBodyType`),
  and `carsQA.btype(i)` prints the real enum so the smoke report shows the type
  instead of you guessing. Diagnose live with
  `page.evaluate("import('/src/components/car-modules/crashManager.js')")` +
  counting bodies by type — a `{fixed:2, dynamic:26}` histogram with 26 parked
  cars is the tell.
- `world.castRay` signature: `(ray, maxToi, solid)` (compat build also has
  `castRayAndGetNormal`) — always wrap in try/catch, `ray.free()` the WASM
  Ray, and prefer a `timeOfImpact > 0.4` distance guard over exclude filters.
  Exclude args exist but are version-fragile — don't rely on them.
- `useParkingSpots` MUST be keyed on the MAP spawn on BOTH sides (ParkedCars
  and PlayerBody's enter detection). Keying PlayerBody on the post-exit
  `respawn` point produced a DIFFERENT spot list (spots are sorted/filtered
  relative to the anchor), so `nearCar` indices pointed at the wrong cars —
  F did nothing, or "entered" a car across the map and the character looked
  separated from it. Same key => the module cache hands both sides the same
  array (and skips the refetch, so re-entry works on the first 100 ms tick).
- Driven cars move away from their parking spot: `CarDriver` (per frame) and
  `exitCar` (final) write the car's real position into `CAR_LIVE_POS[i]`
  (stable {x,z} objects, mutated in place), and `CarEntrance` prefers it over
  `spots[i].position`. Without it the car you just exited was undetectable.
- Exit placement is ray-cleared (right/left 2.4 & 4.0 m, back 4.6, front 5.4):
  the old fixed 3.4 m right pop landed inside buildings (cars park 3.2 m right
  of the road center) and exactly ON the 3.4 m enter boundary, so the F prompt
  never showed for the just-exited car. 2.4 m stays inside the enter radius.
- On-foot strafe basis is right-handed: right = forward × up = (−cos yaw,
  sin yaw), i.e. `dirX = iz*sinC − ix*cosC`, `dirZ = iz*cosC + ix*sinC`.
  (An earlier build had `+ix*cosC / −ix*sinC`, which mirrored A/D.)
- `driving` is a car INDEX: test `driving === null`, never `!driving` —
  `!0` is true, so App.jsx kept the on-foot player mounted while driving
  car 0 (two camera rigs fighting, double input). Worse, the still-mounted
  player's `clearRespawn` effect consumed the exit handoff instantly, so
  leaving car 0 dropped the character at the map spawn instead of beside
  the car (the "character separated from the car" bug).
- `<RigidBody position>` is APPLIED on prop changes — it teleports the body.
  PlayerBody freezes its mount position in a ref (`spRef`): `respawn` is
  cleared right after mount, and without the frozen ref `sp` flips back to
  the map spawn, teleporting the fresh body 12+ m away from the car.
- Enter/exit same-keydown race: entering mounts `CarDriver` (and exiting
  mounts `CarEntrance`) DURING the F keydown, and that same event then
  reaches the freshly attached listener on the other side — one press could
  enter AND exit (F "did nothing"). Both sides ignore F/B for 350 ms after
  mount (`mountedAt` refs in CarEntrance + CarDriver).
- `<Merged>` mesh keys must be stable across renders or the tab freezes.
- **React nulls refs BEFORE passive-effect cleanup in a deleted tree.**
  `Protagonist`'s cleanup passed `innerRef.current` (already `null`) to
  `mixer.uncacheRoot()` → `Cannot read properties of null (reading 'uuid')`
  → error boundary unmounted the `<Canvas>` = **crash on entering a car**
  (entering unmounts the on-foot character). Fix: capture the node at effect
  start (`const root = innerRef.current`) and use the captured value + an
  early-return in the cleanup. Never touch `ref.current` in a cleanup.
- **On-foot camera yaw must come from the movement basis, not the model
  quaternion.** The character group is rotated `yaw + PI` (its FBX faces −Z),
  so the model's +Z is the character's BACK. `CameraRig` therefore takes a
  `yawRef` prop: Player passes its `camYaw` ref (the same yaw the WASD basis
  uses); without it the rig read model +Z as view-forward → camera sat in
  front of the face and S whipped the camera 180° instead of walking back.
  The car passes NO yawRef (its model group has no offset — +Z is the nose).
- `setGameTime` re-renders HUD — keep it throttled (≈4 Hz is plenty).
- Shadow quality comes from box tightness, not map size: keep the ortho box
  small and follow the player; never widen it to cover the city.
- HUD is minimal on purpose (clock + prompt). Camera = keys only.
- **No per-frame allocations in `useFrame`.** The hot offenders were
  `DayNightCycle.getSkyColors()` (3 × `Color.clone()` + an inline phase-object
  literal + a `new Vector3` for the sun) and the hemisphere-light line
  (`clone().lerp(new Color())`) — ~6 short-lived objects *per frame*, i.e. GC
  churn that shows up as stutter. They now write into module-level scratch
  (`skyOut`, `tmpSunDir`, `tmpHemi`, `COLOR_WHITE`, `SKY_PHASES`).
  `DebugOverlay` likewise mutates one `statsSnap` object instead of allocating a
  new one 3×/sec — and because the reference is stable, `window.__gtathensStats`
  read from the console always shows *current* values. When adding anything to a
  `useFrame`: reuse `{x,y,z}`/Vector3/Color scratch, never `.clone()`,
  `new Vector3()`, `new Color()`, `{}` or `[]` inside the callback. Ternaries
  that pick between two statics (`return SKY_COLORS.night`) are fine as long as
  callers only read them.
- `body.linvel()` / `body.rotation()` return fresh Rapier objects every call, so
  call them once per frame and reuse the result — don't call them 3× for 3
  components.
- **Car crash system (Car.jsx)**: all crash state is module-level and mutated
  in place (`CAR_DAMAGE` / `CAR_LOOSE` / `CAR_BODIES` / `BODY_TO_SPOT` /
  `CAR_DENT_SETTERS`). Impact handlers gate on the **fixed side** of the
  contact pair — rapier dispatches every event to BOTH bodies' handlers, so
  letting the dynamic side act would double-count damage. Knocked-loose cars
  are `setBodyType('dynamic')` IMPERATIVELY (no React re-render); the
  `dynamic` prop only flips for the DRIVEN car, so r3f never clobbers the
  manual state, and `LooseSettler` re-freezes settled cars + bakes
  `CAR_LIVE_POS` (enter detection follows a shoved car). CarModel must clone
  the shared FBX materials before darkening (the useFBX cache shares materials
  across every car of the same model). Both `onCollisionEnter` (new contacts)
  and `onContactForce` (persistent-contact re-rams, raw
  `setContactForceEventThreshold` cuts ground noise) funnel into
  `crashHitFromPayload`. HUD chip = `store.carDamage`, synced change-gated by
  CarDriver (never per frame).
- `smoke.mjs` includes a crash test: it's still driving car 0 after the
  re-enter check, then calls `window.__gtathensCars.ram(target)` (teleports
  the driven car 6.5 m behind a parked car) and holds a real W key. PASS needs
  the victim to move > 0.25 m AND take damage.
- **Building colliders must trace the RENDERED model, not the OSM outline.**
  The visual mesh is a Kenney model fitted to the footprint's bounding box
  (`sx = w*0.94/meta.w`) — so collision sourced from the OSM polygon (or its
  bbox) mismatches the visible walls by up to ~3% on every side (invisible
  walls) and lets you clip through visible corners. `buildKenneyCache` now
  computes each model's exact XZ silhouette (`xzHull`: convex hull of all
  vertices, simplified to >10° turns), and `planBuildings` maps it through the
  SAME transform as the mesh group. The T*R*S order matters — scale each local
  axis by its OWN factor first, then rotate (an early version scaled the
  rotated frame with sx uniformly and was up to 0.75 m off at rot=±π/2;
  verified against THREE.Matrix4). `scripts/model-footprints.mjs` measures
  model silhouettes (all 60 Kenney models are 0.80-1.00 hull/aabb, i.e.
  boxy — so ONE convex hull per building stays exact; no decomposition needed).
- **Detour's `findNearestPoly` returns `success: true` with `ref: 0` and an
  UNINITIALIZED nearest point when it finds nothing** (observed:
  `2.589599562072262e-41` coordinates). Never trust `success` alone —
  `navNearest` in `lib/navmesh.js` treats `ref 0n`/`nearestRef`-less results as
  a miss and returns `null`. A query helper that trusted `success` handed
  peds garbage targets that walked them to (0,0).
- **OSM ways in this map crop do NOT share junction nodes** — ways that cross
  leave 2-10 m gaps, so a road graph built from shared nodes alone is 27.5%
  connected (measured). `STITCH_R = 8.0` in RoadPathfinder reconnects to
  97.8%; the radius sweep is documented on the constant (r=12-15 adds ~2×
  the stitches for +1.5% — parallel roads merging, i.e. false junctions).
  Don't "fix" routing failures by shrinking it to 2 m — cross-town routes
  fail again.
- **Firing from the muzzle along the CAMERA direction misses close targets by
  the arm offset** (~0.4 m lateral at 3-4 m — a ped-sized hole). WeaponController
  now does two-stage aim: camera ray → aim point, then muzzle → aim point for
  the hit ray (tracer still leaves the muzzle). The smoke shoot test went from
  `impacts 26, hits 0` (and a FAIL) to hits>0 + kills. Keep the two-stage
  structure if editing the fire path; `scripts/rayprobe.mjs` re-proves the
  collider side in ~25 s.
- **Peds sit in GROUP_PLAYER** (shared filter mask), so a ray that excludes the
  player's own group would also skip every ped — one more reason to check the
  ray path before "peds are invulnerable" reports (see the aim gotcha above).
- **The pavement is a PHOTO, not a bake.** The plaza texture
  (`public/textures/tiles.jpg`) is the reference image the city's look was
  approved from, used byte-for-byte (verified by SHA-256 against the source
  file). An earlier attempt procedurally *recreated* the pattern into
  `public/textures/kaykit-pavement.png` via `scripts/bake-pavement.mjs`; both
  are deleted — do not reintroduce a generator, a resample, or a "cleaner"
  upscaled variant. `Ground.jsx` maps the photo through `TILE_M = 8` (one
  image = 8 m = the 4×4 slabs at 2 m each) and `WORLD_M / TILE_M` = 500×500
  repeats. The smoke report's ground probe prints `tex` + `texelsPerM`, so the
  load is provable without eyes: `"tex":"1600x1600","texelsPerM":200` = the
  real photo (the old bake read 1024×1024 / 128).

## Running the game headlessly (smoke test)

You cannot see the browser, but you CAN boot the real game and read its state.
`workspace/scripts/smoke.mjs` drives headless Chrome over CDP (no npm deps —
Node's global `fetch` + `WebSocket`), captures **uncaught exceptions with
stack traces**, clicks PLAY, and prints live DOM + Rapier state. It is how the
`RuntimeError: unreachable` black-screen bug above was found.

```powershell
# 1) start chrome with remote debugging (dedicated profile — do NOT reuse the
#    user's profile, and close it afterwards)
# One command: smoke.mjs locates Chrome/Edge, launches it headless on port 9222
# with a throwaway profile, then kills it + deletes the profile when done. Set
# CHROME_PATH to override. If something already answers CDP on 9222 it attaches
# to that instead. Takes ~16 s, so run it in the background to dodge the 30 s
# command timeout:
cd workspace; Start-Process node -ArgumentList 'scripts/smoke.mjs','http://127.0.0.1:5173/','10','6' -WindowStyle Hidden
Start-Sleep -Seconds 24; Get-Content scripts/smoke-report.txt
```

A healthy report is `canvas:true`, `rootChildren:1`, `bodies:2`, `colliders:406` at
the menu, then after PLAY `canvas:true`, `bodies:44`, `colliders:448`, ~57-60 fps,
`uncaught exceptions: none`, `console errors: none`, and HUD text like
`DIMITRI 08:07 $0 100 Fists`. The probe exposes `window.__gtathensStats` /
`window.__gtathensPhysics`, so any extra invariant can be checked by adding to
`PROBE` in the script.

Test sections and their PASS criteria (the run now takes ~50 s, so poll the
report instead of shortening the sleeps):

- **W/S/D movement** — W must move ≥2 m away from camera-forward, S ≥2 m back,
  D along camera-RIGHT, camera yaw drift ~0° (no 180° flip).
- **Car enter/exit/re-enter (real F key)** — `carHookGone` while driving, hook
  back after exit, and the player must land inside the 3.4 m enter radius of
  spot 0 (`post-exit player vs spot0`).
- **`rb.setBodyType('fixed')` is a trap — the raw rapier `RigidBodyType` is an
  ENUM, so numeric only.** Rapier's generated `RawRigidBodySet.setBodyType(handle,
  type)` expects `0 = Dynamic, 1 = Fixed, 2 = KinematicPositionBased,
  3 = KinematicVelocityBased`. Passing a *string* is "accepted" and coerced to
  `0` (Dynamic) — no error, no warning. `@react-three/rapier`'s `<RigidBody
  type="fixed">` works because it converts via `rigidBodyTypeFromString()` first;
  the raw JS wrapper does not. The *original* `Car.jsx` survived this by braving
  `setLinvel({0,0,0})` + `setAngvel({0,0,0})` on the same line, so a frozen
  "fixed" car looked fine. The modular rewrite dropped the vel-zeroing and every
  knocked-loose car (and `LooseSettler`'s re-freeze) silently stayed DYNAMIC: it
  drifted on collision, and the crash gate (`isFixed()`) could never fire again —
  `CRASH TEST: FAIL, damage=0, looseNow=0` while the ram clearly moved the victim.
  The live registry diag (dynamic-import `car-modules/crashManager.js` from the
  smoke page, count `bodies[i].bodyType()`) showed **`{fixed:2, dynamic:26}`: ALL
  26 parked cars dynamic**. Fix: `setRigidBodyType(rb, RB_FIXED)` in
  `car-modules/crashManager.js` (exports `RB_DYNAMIC/RB_FIXED/RB_KINEMATIC_POS/
  RB_KINEMATIC_VEL` + `setRigidBodyType`), and `crash.setBodyType(i, RB_FIXED)`
  everywhere else. `carsQA.btype(i)` reports the live type so a regression is one
  smoke line away instead of a mystery FAIL.
- **Diagnose physics state from the page, not from guesses.** `page.evaluate`
  runs with `awaitPromise: true`, so a CDP probe can `await import('/src/
  components/car-modules/crashManager.js')` and read the *real* module singleton
  (Vite serves ES modules over HTTP, so the dev server IS the test oracle). That
  is how the enum bug above was found — `hist`/`rows[].body{type,handle,
  liveInWorld}` immediately distinguished "wrong body type" from "wrong index
  mapping" (handles `1.5e-323 … 3.5e-323` = slots 1..5, i.e. mapping was fine).
  Reset the module state with `crash.reset()` rather than `circle.delete(i)`
  (`crash` exposes `bodies`/`livePos`/`damage`/`loose`/`looseSince`/`dentSetters`
  /`lastHit`/`spots`) — clearing `loose` alone made the next hit *permanently*
  ignored by the dent cache.
- **Reusing the pre-existing `window.__gtathensCars` seam: don't let two writers
  race.** `Car.jsx` used to install the QA hook at module scope (reading a frozen
  `spotsCache` snapshot) while `<ParkedCars>` installed a second one; the barrel
  now keeps a *fallback* (no live spawn) and the mounted component owns the
  authoritative, live one, removing its keys on unmount.
- **`node scripts/smoke.mjs` must be parse-checked too** — a stray `)` from an
  edit made the script die with `SyntaxError: Unexpected token ')'` *before*
  launching Chrome, which left the previous `smoke-report.txt` on disk. Reading a
  stale report looks exactly like "the test ran and failed the same way". Always
  compare `(Get-Item scripts/smoke-report.txt).LastWriteTime` against the clock
  and `Get-Content smoke-live.log -Tail` for the real outcome. Also: Vite/npm
  backgrounded with `start /b` dies with the shell call — use
  `Start-Process -WindowStyle Hidden` (and `-RedirectStandardOutput`) so the dev
  server outlives the 30 s command timeout.

- **Car-vs-car crash (ram)** — PASS needs the victim to move > 0.25 m AND take
  damage (`CRASH TEST: PASS`).
- **Shooting (`SHOOT TEST`)** — exercises guns → peds → loot for real: grants an
  SMG via the store action (`window.__gtathensGive('smg', 90)`), teleports the
  player 1.25 m behind the nearest living ped FACING it, holds the REAL X key for
  2.6 s while a page-side `setInterval` re-aims at the ped's LIVE position every
  80 ms (peds walk ~1.5 m/s, so a static burst misses), then requires `hp` to
  drop or `dead:true`, plus `kills`/`money` to move and the `loot drops` counter
  to change. `shot telemetry` prints
  `{shots, impacts, hits, x/y/z, toi, ox/oy/oz, px/py/pz}` — read it FIRST when
  chasing a shooting bug: `shots:0` = input/ammo never reached the fire path;
  `impacts>0, hits:0` with `ox/oz` near `(0,0)` = the gun is not parented to the
  character (see the muzzle gotcha); `hits>0` but no death = damage tuning.

QA hooks the script consumes (all stable objects, zero per-frame alloc):

- `window.__gtathensPlayer` — `{x,y,z,camYaw,t}`, written every physics frame.
  smoke.mjs measures W and S displacement against camera-forward and fails if
  W doesn't move ≥2 m away or S doesn't come back.
- `window.__gtathensCam` — camera position/quat, for the same measurement.
- `window.__gtathensCar` — enter-car test seam: `tp()` teleports the player into
  a parked car's enter radius, so the test presses the REAL F key (drei
  `KeyboardControls` listens on `window`, so synthetic `KeyboardEvent`s
  with `code:'KeyF'` work), then drives/exit-checks — this is how the
  `uncacheRoot(null)` crash on entering a car was reproduced and verified fixed.
- `window.__gtathensCars` (Car.jsx) — `.count()/.pos(i)/.damage(i)/.loose()/
  .spot(i)/.ram(i)`; `ram()` teleports the driven car 6.5 m behind a target and
  floors it with a real W key.
- `window.__gtathensTp(x, z, yaw)` (Player.jsx) — generic player teleport for the
  shoot test; the optional `yaw` sets `camYaw` AND `yaw` together so the chase
  camera (and therefore the aim ray) faces a target.
- `window.__gtathensNpcs` (Npcs.jsx) — `.count()/.ped(i)/.aliveCount()/
  .nearest(x,z)`; returns the very records `WeaponController` damages.
- `window.__gtathensPickups` (Pickups.jsx) — module-level `remaining()/list()/
  tpNearest()` PLUS the `drops()` counter merged in by the mounted component.
- `window.__gtathensShot` (WeaponController.jsx) — last-shot telemetry
  (`shots/impacts/hits/x/y/z/toi/muzzle/ox/oy/oz/px/py/pz`), written once per
  SHOT, never per frame.
- `window.__gtathensGive(id, ammo)` and `window.__gtathensStore`
  (`{money,health,equipped,kills,guns,mag}`) from the store — grant a gun / read
  the economy without poking React.

Caveat: `--virtual-time-budget` + `--dump-dom` breaks Rapier (absurd frame
deltas → WASM traps), so use the CDP script, not a one-shot `--dump-dom`.

Also useful: `node scripts/parse-check.mjs` (syntax), `node scripts/hull-repro.mjs`
(convex-hull collider path in isolation).

## Phantom "syntax error" diagnostics (read this before chasing a JSX error)

This is a plain-JS project, so `workspace/jsconfig.json` (`allowJs`,
`checkJs:false`, `jsx:"react-jsx"`) exists purely so the VS Code TypeScript
server loads a *real* project instead of a stale "inferred project". Symptom of
a stale TS server: the Problems panel reports things like

    App.jsx(144,5): JSX expressions must have one parent element.
    App.jsx(152,9): Expected corresponding JSX closing tag for 'div'.
    Protagonist.jsx(171,1): Declaration or statement expected.

…while the code on disk is perfectly balanced. Those cascades (a bogus extra
`</div>` → sibling roots → `')' expected`) come from TS parsing a file it read
**mid-write (truncated)**. The vite dev log shows the same thing from Babel as
`<file>: Unexpected token, expected "," (N:0)` — always at end-of-file.

Before touching any code, prove the file is fine — all three must pass:

- `node scripts/parse-check.mjs` (run from `workspace/`) parses every
  `src/**/*.js(x)` with the exact Babel plugin set the react plugin uses.
- The **live** dev server answers HTTP 200 for the module (an error body would
  come back as a 500 with the transform error):
  `Invoke-WebRequest http://127.0.0.1:5173/src/App.jsx -UseBasicParsing | Select StatusCode`
- `npm run build` is clean. Note PowerShell renders Vite's yellow chunk-size
  advisory on stderr as a `NativeCommandError`; redirect via `cmd /c "... > out.txt 2>&1"`
  and check `$LASTEXITCODE` instead of trusting the console colour.

If all three pass, the fix is to refresh the tooling, not the code:
`Ctrl+Shift+P → "TypeScript: Restart TS Server"` (or Reload Window), and
hard-reload the browser tab (`Ctrl+Shift+R`) — the Vite overlay of a long-lived
dev server can outlive the fixed file (in this session one had been up since
7:52 AM holding `127.0.0.1:5173`). Bumping a file's mtime alone (content
unchanged, verify with `Get-FileHash` before/after) is usually enough to force
both the TS server and the Vite watcher to re-read it — the log then shows a
fresh `hmr update` with no error. `dev-err.log` / `dev-out.log` at the project
root are the dev server's stderr/stdout: compare the last timestamp in
`dev-out.log` against the file mtimes before believing any error message in them.
