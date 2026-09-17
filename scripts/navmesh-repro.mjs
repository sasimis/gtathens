// Proof harness for the pedestrian navmesh path.
//
//   cd workspace && node scripts/navmesh-repro.mjs
//
// It imports the PRODUCTION module (src/lib/navmesh.js) — not a copy — so it
// verifies the real geometry builder, config translation and query wrappers in
// plain Node, with no browser and no scene graph.
//
// The questions it answers, each with a decisive experiment:
//
//   T1  does init() + threeToSoloNavMesh() work at all in ESM?
//   T2  is rcConfig.walkableRadius VOXELS or METRES?  (a 2 m corridor that
//       connects two areas: through ~80 m vs around ~130 m)
//   T3  same for walkableHeight (3 m of head room under a slab)
//   T4  do building prisms actually CARVE the navmesh?
//   T5  is a building's INTERIOR unreachable (not a walkable island)?
//   T6  city-scale cost: 400 m tile, 120 building prisms
//   T7  does Crowd.addAgent + requestMoveTarget + update work headlessly?
//
// Always writes scripts/navmesh-repro.txt and exits 0, so a failed check still
// leaves a readable report.
import { appendFileSync, writeFileSync } from 'node:fs'
import {
  NAV_DEFAULTS,
  buildNavGeometry,
  buildNavMesh,
  createCrowd,
  createNavQuery,
  ensureNavReady,
  navConfig,
  navMeshPolyCount,
  navNearest,
  navPath,
  navRandomPointAround,
  pathLength,
  pushGround,
  pushPrism,
  samplePath,
} from '../src/lib/navmesh.js'

const F = new URL('./navmesh-repro.txt', import.meta.url).pathname.replace(/^\//, '')
writeFileSync(F, '')
const w = (s) => appendFileSync(F, String(s) + '\r\n')
const hr = (s) => w(`\r\n--- ${s} ---`)
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  w(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ */
/* thin adapters over the production module                            */
/* ------------------------------------------------------------------ */

const newGeom = () => ({ positions: [], indices: [] })

// An axis-aligned obstacle, expressed through the production `pushPrism` so
// every probe also exercises the ring-winding normalisation.
const pushBox = (g, cx, cz, w2, d2, h, y0 = 0) =>
  pushPrism(
    g,
    [
      [cx - w2, cz - d2],
      [cx + w2, cz - d2],
      [cx + w2, cz + d2],
      [cx - w2, cz + d2],
    ],
    h,
    y0,
  )

// `cfg` is passed RAW (voxel values included) because T2/T3 are exactly the
// experiments that pin down those units.
const build = (g, cfg, half, pruneFrom = null) => {
  const geom = {
    positions: new Float32Array(g.positions),
    indices: new Uint32Array(g.indices),
    bounds: [
      [-half, -1, -half],
      [half, 40, half],
    ],
  }
  const res = buildNavMesh(geom, cfg, { pruneFrom })
  return { res, ms: res.ms }
}

const polyCount = (navMesh) => navMeshPolyCount(navMesh)

// Uses the production query wrappers, so a regression in them shows up here.
const pathInfo = (navMesh, from, to) => {
  const q = createNavQuery(navMesh)
  return navPath(q, from, to)
}

const onMesh = (navMesh, x, z) => {
  const q = createNavQuery(navMesh)
  const n = navNearest(q, x, z)
  if (!n) return { success: false, onMesh: false, nearestY: null }
  return { success: true, onMesh: n.onMesh, nearestY: Number(n.y.toFixed(2)) }
}

/* ------------------------------------------------------------------ */

hr('T1 - init + buildNavMesh')
try {
  await ensureNavReady()
  w('ensureNavReady(): OK (wasm loaded from the @recast-navigation/wasm compat build)')
} catch (e) {
  w(`ensureNavReady(): FAIL ${e.constructor.name}: ${e.message}`)
  w('\r\ndone')
  process.exit(0)
}

// Flat ground + one wall prism at the origin: 12 m wide, 8 m deep, 8 m tall.
{
  const g = newGeom()
  pushGround(g, 0, 0, 60)
  pushBox(g, 0, 0, 6, 4, 8)
  const { res, ms } = build(g, navConfig(), 60)
  check('T1 build succeeds', res.success, res.success ? `${polyCount(res.navMesh)} polys, ${ms} ms` : res.error)
  if (res.success) {
    // A straight line is 40 m; the wall forces a detour.
    const through = pathInfo(res.navMesh, [-20, 0], [20, 0])
    const clear = pathInfo(res.navMesh, [-20, 14], [20, 14])
    w(`path (-20,0)->(20,0): ${through.found ? `${through.length.toFixed(2)} m` : 'NOT FOUND'}`)
    w(`path along open ground: ${clear.found ? `${clear.length.toFixed(2)} m` : 'NOT FOUND'} (expect ~40)`)
    check('T4 building prism carves the mesh', through.found && through.length > 41, `detour ${through.length.toFixed(2)} m > 40 m straight`)
    check('ground is walkable', clear.found && Math.abs(clear.length - 40) < 1)
    res.navMesh.destroy()
  }
}

hr('T2 - walkableRadius units (2 m corridor between two areas)')
{
  // Two walls parallel to Z leave a 2 m gap (x = -1..1) over 60 m of length, so
  // the gap connects the south side to the north side: "through" ~80 m,
  // "around the ends" ~130 m. The difference is what makes this decisive.
  const corridor = (radius) => {
    const g = newGeom()
    pushGround(g, 0, 0, 90)
    pushBox(g, -16, 0, 15, 30, 6) // x = -31..-1
    pushBox(g, 16, 0, 15, 30, 6) // x = 1..31
    return build(g, {
      cs: 0.3, ch: 0.2, walkableSlopeAngle: 45, walkableHeight: 6, walkableRadius: radius,
    }, 90)
  }
  const r2 = corridor(2)
  const r5 = corridor(5)
  const len2 = r2.res.success ? pathInfo(r2.res.navMesh, [0, -40], [0, 40]).length : 0
  const len5 = r5.res.success ? pathInfo(r5.res.navMesh, [0, -40], [0, 40]).length : 0
  w(`walkableRadius=2 (2 vox = 0.6 m/side): centre ${JSON.stringify(onMesh(r2.res.navMesh, 0, 0))}, ` +
    `south->north ${len2.toFixed(2)} m`)
  w(`walkableRadius=5 (5 vox = 1.5 m/side): centre ${JSON.stringify(onMesh(r5.res.navMesh, 0, 0))}, ` +
    `south->north ${len5.toFixed(2)} m`)
  check('walkableRadius is VOXELS', len2 < 100 && len5 > 100, 'r=2 goes through, r=5 is pushed around')
  r2.res.navMesh?.destroy()
  r5.res.navMesh?.destroy()
}

hr('T3 - walkableHeight units (head room under a slab whose underside is at 3 m)')
{
  // Measured threshold with ch = 0.2: 14 voxels stay walkable, 15 (exactly
  // 3.0 m / ch) does not — so the unit is VOXELS. These two probes sit far from
  // that boundary on purpose, so the test cannot be won by quantization luck.
  //   9 voxels * 0.2 = 1.8 m required < 3 m present -> walkable
  //   20 voxels * 0.2 = 4.0 m required > 3 m present -> not walkable
  // If the values were METRES both would be unwalkable and this would fail.
  const probe = (height) => {
    const g = newGeom()
    pushGround(g, 0, 0, 40)
    // A CLOSED slab (bottom: true). Without the base fan recast measures head
    // room to the roof instead of to the underside and the probe lies.
    pushPrism(g, [[-20, -20], [20, -20], [20, 20], [-20, 20]], 4, 3, { bottom: true })
    const out = build(g, {
      cs: 0.3, ch: 0.2, walkableSlopeAngle: 45, walkableRadius: 2, walkableHeight: height,
    }, 40)
    const on = out.res.success ? onMesh(out.res.navMesh, 0, 0) : null
    out.res.navMesh?.destroy()
    return on
  }
  const low = probe(9)
  const high = probe(20)
  w(`walkableHeight=9 (1.8 m) under a 3.0 m slab: ${JSON.stringify(low)}`)
  w(`walkableHeight=20 (4.0 m) under a 3.0 m slab: ${JSON.stringify(high)}`)
  check('walkableHeight is VOXELS', low?.onMesh === true && high?.onMesh === false)
}

hr('T5 - a building interior must not be walkable (production geometry path)')
{
  // 20 x 20 building, 8 m tall, centred on the origin, planned exactly the way
  // City.jsx plans a real one: a world-space `footprint` ring + `colH`. The
  // interior must NOT be a walkable island — `floorCap` is what prevents it.
  const geom = buildNavGeometry({
    center: [0, 0],
    half: 60,
    buildings: [{ footprint: [[-10, -10], [10, -10], [10, 10], [-10, 10]], colH: 8 }],
  })
  const out = buildNavMesh(geom, navConfig())
  if (!out.success) {
    check('T5 build succeeds', false, out.error)
  } else {
    const navMesh = out.navMesh
    const q = createNavQuery(navMesh)
    const n = navNearest(q, 0, 0)
    const d = n ? Math.hypot(n.x, n.z) : null
    w(`nearest walkable point to the building centre: ` +
      `${n ? `(${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)})` : 'none'}`)
    check('interior is not walkable', n === null || (!n.onMesh && d > 8),
      n === null
        ? 'no walkable poly anywhere near the centre'
        : `nearest mesh point ${d.toFixed(2)} m from the centre (building half-width 10 m)`)
    const around = pathInfo(navMesh, [-30, 0], [30, 0])
    check('path detours around the block', around.found && around.length > 61,
      `${around.found ? around.length.toFixed(2) : 'n/a'} m (straight would be 60)`)
    // Floor cap sanity: an agent standing just outside the wall IS on the mesh.
    const outside = navNearest(q, 12, 0)
    check('ground outside the wall is walkable', outside !== null && outside.onMesh)
    navMesh.destroy()
  }
}

hr('T6 - city-scale build through buildNavGeometry + navConfig')
{
  // A City-like plan: rectangular "buildings" with the same fields
  // planBuildings() emits (world `footprint` ring + real `colH`).
  const buildings = []
  for (let i = 0; i < 120; i += 1) {
    const a = (i * 2654435761) >>> 0
    const b = (i * 1274126177) >>> 0
    const cx = ((a % 1000) / 1000 - 0.5) * 360
    const cz = ((b % 1000) / 1000 - 0.5) * 360
    const hw = (8 + (a % 30)) / 2
    const hd = (8 + (b % 30)) / 2
    buildings.push({
      footprint: [[cx - hw, cz - hd], [cx + hw, cz - hd], [cx + hw, cz + hd], [cx - hw, cz + hd]],
      colH: 6 + (a % 40),
    })
  }
  const geom = buildNavGeometry({ center: [0, 0], half: 200, buildings })
  // Centre of a specific building, so the interior checks below target a
  // footprint that definitely exists (the tile centre may well be open road).
  const b0 = buildings[0].footprint
  const b0c = [(b0[0][0] + b0[2][0]) / 2, (b0[0][1] + b0[2][1]) / 2]
  const out = buildNavMesh(geom, navConfig())
  const res = { success: out.success, navMesh: out.navMesh, error: out.error }
  const ms = out.ms
  w(`geometry: ${geom.prisms} prisms, ${geom.skipped} skipped, ` +
    `${(geom.positions.length / 3).toFixed(0)} verts / ${(geom.indices.length / 3).toFixed(0)} tris`)
  check('T6 city build succeeds', res.success,
    res.success ? `${polyCount(res.navMesh)} polys, ${ms} ms, pruned=${out.pruned}` : res.error)
  if (res.success) {
    const q = createNavQuery(res.navMesh)
    const t0 = Date.now()
    const path = navPath(q, [-150, -150], [150, 150])
    const pathMs = Date.now() - t0
    check('long-range path found', path.found && path.length > 400,
      `${path.length.toFixed(1)} m in ${pathMs} ms, ${path.points.length} waypoints`)
    // Every waypoint must be a real point on the mesh (no cutting corners
    // through buildings). Measured as distance-to-mesh, not `isOverPoly`:
    // corridor corners sit exactly ON poly boundaries, where isOverPoly is
    // legitimately false.
    let off = 0
    let worst = 0
    for (const p of path.points) {
      const n = navNearest(q, p[0], p[1])
      const d = n ? Math.hypot(n.x - p[0], n.z - p[1]) : Infinity
      worst = Math.max(worst, d)
      if (d > 0.5) off += 1
    }
    check('all waypoints sit on the mesh', off === 0, `worst offset ${worst.toFixed(3)} m`)
    // City-scale floor-cap check: the interior of a known building is not
    // walkable even without any pruning.
    const inter = navNearest(q, b0c[0], b0c[1])
    check('no walkable building interiors at city scale', inter === null || !inter.onMesh,
      `building centre ${inter && inter.onMesh ? 'IS' : 'is not'} walkable`)
    const out = { x: 0, z: 0, yaw: 0, done: false }
    samplePath(path.points, path.length * 0.5, out)
    check('samplePath walks to the midpoint', !out.done && Number.isFinite(out.x) && Number.isFinite(out.yaw))
    w(`samplePath(mid) -> x ${out.x.toFixed(2)}, z ${out.z.toFixed(2)}, yaw ${out.yaw.toFixed(3)}`)
    const rand = navRandomPointAround(q, 0, 0, 120, 7)
    check('deterministic wander target', rand !== null && Number.isFinite(rand.x), rand ? `(${rand.x.toFixed(2)}, ${rand.z.toFixed(2)})` : 'none')
    const again = navRandomPointAround(q, 0, 0, 120, 7)
    check('wander target is reproducible for a seed', rand && again && rand.x === again.x && rand.z === again.z)

    const crowd = createCrowd(res.navMesh, { maxAgents: 16, maxAgentRadius: 0.6 })
    const agents = []
    for (let i = 0; i < 10; i += 1) {
      const p = navRandomPointAround(q, 0, 0, 60, 100 + i) || { x: i * 2, z: 0 }
      agents.push({
        agent: crowd.addAgent({ x: p.x, y: 0, z: p.z }, {
          radius: 0.4, height: 1.8, maxSpeed: NAV_DEFAULTS.agentRadius + 1.1,
        }),
        from: p,
      })
    }
    for (const a of agents) {
      const t = navRandomPointAround(q, a.from.x, a.from.z, 80, 500)
      if (t) a.agent.requestMoveTarget({ x: t.x, y: 0, z: t.z })
    }
    for (let f = 0; f < 240; f += 1) crowd.update(1 / 60)
    let moved = 0
    let onMeshAgents = 0
    for (const a of agents) {
      const p = a.agent.position()
      moved += Math.hypot(p.x - a.from.x, p.z - a.from.z)
      const n = navNearest(q, p.x, p.z)
      if (n && n.onMesh) onMeshAgents += 1
    }
    check('T7 crowd moves agents along the mesh', moved > 5,
      `${moved.toFixed(1)} m total over 240 frames`)
    check('T7 agents stay on the mesh', onMeshAgents === agents.length, `${onMeshAgents}/${agents.length} on mesh`)
    crowd.destroy()

    // Pruning, with a TRUSTED seed: re-build the same tile seeded from a point
    // on open ground and confirm it neither breaks routing nor leaves the
    // interior walkable. (Seeding from the tile centre instead is the mistake
    // that disabled the whole mesh — see the note in buildNavMesh.)
    const seeded = buildNavMesh(geom, navConfig(), { pruneFrom: [-150, -150] })
    if (seeded.success) {
      const sq = createNavQuery(seeded.navMesh)
      const p2 = navPath(sq, [-150, -150], [150, 150])
      const inter2 = navNearest(sq, b0c[0], b0c[1])
      check('pruned mesh still routes', seeded.pruned && p2.found && p2.length > 400,
        `pruned=${seeded.pruned}, ${p2.found ? p2.length.toFixed(1) : 'n/a'} m`)
      check('pruning keeps interiors out', inter2 === null || !inter2.onMesh)
      seeded.navMesh.destroy()
    } else {
      check('pruned mesh builds', false, seeded.error)
    }
    res.navMesh.destroy()
  }
}

w(`\r\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
w('done')