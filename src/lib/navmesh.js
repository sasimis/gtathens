// Pure Recast/Detour helpers behind the pedestrian navmesh.
//
// Deliberately React-free and scene-graph-free (only raw geometry building), so
// this module is importable straight from Node — `scripts/navmesh-repro.mjs`
// exercises this exact code path with no browser. The R3F component that owns
// the lifecycle lives in components/CityNavMesh.jsx.
//
// ---------------------------------------------------------------------------
// UNITS — measured, not guessed. `node scripts/navmesh-repro.mjs` proves each
// one with a corridor experiment:
//
//   cs / ch ................ metres (voxel size)
//   walkableRadius ......... VOXELS  -> agent radius (m) / cs
//   walkableHeight ......... VOXELS  -> agent height (m) / ch
//   walkableClimb .......... VOXELS  -> max step (m) / ch
//   walkableSlopeAngle ..... degrees
//
// recast-navigation-js forwards these straight into the Recast C API, which is
// voxel-based, and only converts back to metres when filling
// `dtNavMeshCreateParams` (`setWalkableRadius(cfg.walkableRadius * cfg.cs)`).
// Sending METRES for the walkable* trio is the classic way to build a navmesh
// that erodes the whole pavement away — a 0.4 m agent radius must go in as
// 2 voxels, never as 0.4.
// ---------------------------------------------------------------------------
import * as THREE from 'three'
import {
  Crowd,
  NavMeshQuery,
  floodFillPruneNavMesh,
  getNavMeshPositionsAndIndices,
  init,
  setRandomSeed,
} from '@recast-navigation/core'
import { threeToSoloNavMesh } from '@recast-navigation/three'

export const NAV_DEFAULTS = {
  cellSize: 0.3, // voxel size in metres
  cellHeight: 0.2, // voxel height in metres
  agentRadius: 0.4, // metres -> walkableRadius voxels
  agentHeight: 1.8, // metres -> walkableHeight voxels
  agentClimb: 0.5, // metres -> walkableClimb voxels
  slopeAngle: 45, // degrees
  radius: 220, // navmesh tile half-size in metres, around the spawn
}

/** Metres -> the voxel-valued Recast config the wasm build actually wants. */
export const navConfig = (overrides = {}) => {
  const p = { ...NAV_DEFAULTS, ...overrides }
  return {
    cs: p.cellSize,
    ch: p.cellHeight,
    walkableSlopeAngle: p.slopeAngle,
    walkableRadius: Math.max(1, Math.ceil(p.agentRadius / p.cellSize)),
    walkableHeight: Math.max(1, Math.ceil(p.agentHeight / p.cellHeight)),
    walkableClimb: Math.max(0, Math.floor(p.agentClimb / p.cellHeight)),
    maxEdgeLen: 32,
    maxSimplificationError: 1.3,
    minRegionArea: 8,
    mergeRegionArea: 20,
    maxVertsPerPoly: 6,
    detailSampleDist: 6,
    detailSampleMaxError: 1,
  }
}

/** Owns the wasm module: must resolve before any NavMesh/Crowd is created. */
let initPromise = null
export const ensureNavReady = () => {
  if (!initPromise) initPromise = init()
  return initPromise
}

/* ------------------------------------------------------------------ */
/* geometry building                                                   */
/* ------------------------------------------------------------------ */

/**
 * WINDING MATTERS: recast decides walkability from each triangle's normal
 * (`markWalkableTriangles`), so a clockwise quad reads as a downward-facing
 * surface and is silently dropped — the navmesh then comes out nearly empty and
 * every path "succeeds" with a single point. `scripts/navmesh-repro.mjs` hit
 * exactly that, which is why every face below is emitted CCW seen from
 * OUTSIDE:
 *   - ground / road quads -> normal +Y  -> walkable
 *   - prism walls         -> vertical   -> unwalkable (an obstacle)
 *   - prism TOP           -> normal -Y  -> unwalkable, so a building is a SOLID
 *     block: the column fills from ground to roof and the interior can never be
 *     walked or pathed into (roofs are deliberately not walkable islands).
 */

const newGeom = () => ({ positions: [], indices: [] })

/** Grid of upward-facing quads covering the tile. */
export const pushGround = (g, cx, cz, half, y = 0, cells = 8) => {
  const step = (half * 2) / cells
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      const x0 = cx - half + i * step
      const x1 = x0 + step
      const z0 = cz - half + j * step
      const z1 = z0 + step
      const base = g.positions.length / 3
      g.positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1)
      g.indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
    }
  }
}

/** Ribbon quads for road segments {ax,az,bx,bz,w} (same shape Roads.jsx publishes). */
export const pushRoads = (g, segs, y = 0) => {
  for (const s of segs || []) {
    const dx = s.bx - s.ax
    const dz = s.bz - s.az
    const len = Math.hypot(dx, dz)
    if (len < 0.05) continue
    const hw = (s.w ?? 6) / 2
    const nx = (-dz / len) * hw
    const nz = (dx / len) * hw
    const base = g.positions.length / 3
    g.positions.push(
      s.ax - nx, y, s.az - nz,
      s.ax + nx, y, s.az + nz,
      s.bx + nx, y, s.bz + nz,
      s.bx - nx, y, s.bz - nz,
    )
    g.indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }
}

/**
 * Extrudes a world-space XZ ring into a solid block (walls + top).
 * The ring is re-oriented to positive signed area first, so callers can pass
 * either winding (`xzHull` and OSM outlines disagree).
 *
 * `bottom` adds a downward-facing base fan for floating geometry (see T3 in
 * scripts/navmesh-repro.mjs). `floorCap` adds the same fan low down inside the
 * block — see the note below, buildings need it.
 *
 * WHY BUILDINGS NEED `floorCap`: recast only cares about *head room*. A block
 * whose walls span ground-to-roof leaves the ground inside it with a full
 * storey of clearance, so the interior stays a VALID WALKABLE SURFACE that
 * happens to be sealed off — a walkable island inside every building. Anything
 * that puts an agent there (a spawn, a wander target, a shove) strands it. A
 * downward-facing fan at `FLOOR_CAP_H` leaves the interior floor only ~1 m of
 * head room, so `filterWalkableLowHeightSpans` drops it. Purely geometric: no
 * trusted seed to supply, and no way to nuke the mesh by guessing the wrong one.
 *
 * WHY EXACTLY 1.0 m — two constraints, both in VOXELS:
 *   upper: the cap must leave LESS than `walkableHeight` of head room, so the
 *          floor under it is dropped. walkableHeight is 9 voxels (1.8 m) here,
 *          the cap leaves ~5 (1.0 m). Safe margin.
 *   lower: the cap must NOT merge into the ground span. The generator passes
 *          `walkableClimb` as recast's `flagMergeThreshold` (2 voxels), and two
 *          spans merge when their heights differ by <= that, taking the max
 *          area — a cap at 0.5 m merged into the floor and came back out as a
 *          WALKABLE poly.
 * So a cap that is too LOW is worse than none at all: it is silently absorbed
 * into the walkable floor. `scripts/navmesh-repro.mjs` T5 covers this.
 */
export const FLOOR_CAP_H = 1.0

export const pushPrism = (g, ring, height, y0 = 0, { bottom = false, floorCap = false } = {}) => {
  const pts = []
  for (const p of ring) {
    const last = pts[pts.length - 1]
    if (last && Math.abs(last[0] - p[0]) < 1e-4 && Math.abs(last[1] - p[1]) < 1e-4) continue
    pts.push([p[0], p[1]])
  }
  if (pts.length > 2) {
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (Math.abs(first[0] - last[0]) < 1e-4 && Math.abs(first[1] - last[1]) < 1e-4) pts.pop()
  }
  if (pts.length < 3) return false
  let area2 = 0
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    area2 += a[0] * b[1] - b[0] * a[1]
  }
  if (Math.abs(area2) < 1e-6) return false // collinear ring: nothing to extrude
  if (area2 < 0) pts.reverse() // normalise to CCW in the (x, z) plane
  const h = Math.max(height, 0.5)
  const top = y0 + h
  // Walls: one quad per edge, wound to face OUT of the ring.
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const base = g.positions.length / 3
    g.positions.push(b[0], y0, b[1], a[0], y0, a[1], a[0], top, a[1], b[0], top, b[1])
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  // Top: fan in the ring's own order -> normal -Y -> solid, never walkable.
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p0 = pts[0]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const base = g.positions.length / 3
    g.positions.push(p0[0], top, p0[1], p1[0], top, p1[1], p2[0], top, p2[1])
    g.indices.push(base, base + 1, base + 2)
  }
  if (bottom || floorCap) {
    // Same fan, but at y0 (+ the low cap offset for floorCap): the ring's own
    // order is already the downward-facing one, which is what makes both of
    // these spans unwalkable.
    const baseY = bottom ? y0 + 0 : y0 + FLOOR_CAP_H
    for (let i = 1; i < pts.length - 1; i += 1) {
      const p0 = pts[0]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const base = g.positions.length / 3
      g.positions.push(p0[0], baseY, p0[1], p1[0], baseY, p1[1], p2[0], baseY, p2[1])
      g.indices.push(base, base + 1, base + 2)
    }
  }
  return true
}

/**
 * Turns a City building plan (`planBuildings` output: world-space `footprint` /
 * `outline` ring + real rendered height `colH`) into navmesh obstacle geometry.
 *
 * Only buildings fully inside the tile are emitted, and the tile rect is handed
 * to recast as explicit `bounds`, so the heightfield never depends on how far a
 * stray model pokes out. A building straddling the edge is skipped: its prism
 * would inflate the bounds and make the build cost grow with the whole city
 * instead of with the tile.
 */
export const buildNavGeometry = ({
  center = [0, 0],
  half = NAV_DEFAULTS.radius,
  buildings = [],
  ground = true,
  y = 0,
} = {}) => {
  const g = newGeom()
  if (ground) pushGround(g, center[0], center[1], half, y)
  const minX = center[0] - half
  const maxX = center[0] + half
  const minZ = center[1] - half
  const maxZ = center[1] + half
  let prisms = 0
  let skipped = 0
  for (const b of buildings) {
    const ring = b.footprint && b.footprint.length >= 3 ? b.footprint : b.outline
    if (!ring || ring.length < 3) {
      skipped += 1
      continue
    }
    let inside = true
    for (const p of ring) {
      if (p[0] < minX || p[0] > maxX || p[1] < minZ || p[1] > maxZ) {
        inside = false
        break
      }
    }
    if (!inside) {
      skipped += 1
      continue
    }
    if (pushPrism(g, ring, Math.max(b.colH || b.h || 4, 1), 0, { floorCap: true })) prisms += 1
    else skipped += 1
  }
  return {
    positions: new Float32Array(g.positions),
    indices: new Uint32Array(g.indices),
    prisms,
    skipped,
    bounds: [
      [minX, -1, minZ],
      [maxX, 40, maxZ],
    ],
  }
}

/**
 * Builds a solo navmesh from that geometry. `bounds` pins the heightfield to
 * the tile; the walkable* config values are voxel-based (see the UNITS note at
 * the top of this file).
 *
 * PRUNING IS OPT-IN, AND THE SEED MUST BE TRUSTED. `floorCap` already keeps
 * building interiors out of the mesh (see `pushPrism`), so pruning is defence in
 * depth against other sealed pockets (enclosed courtyards, gaps between
 * footprints). It is easy to get catastrophically wrong, though: seeding from
 * the tile centre landed INSIDE a prism in scripts/navmesh-repro.mjs, which kept
 * that prism's interior and disabled the entire city — every query returned
 * "not found". So there is no default seed here. Pass `pruneFrom` with a point
 * you know is reachable (the player spawn, which sits on a road) or leave it out
 * entirely.
 */
export const buildNavMesh = (geom, config = {}, { pruneFrom = null } = {}) => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(geom.positions, 3))
  geometry.setIndex(new THREE.BufferAttribute(geom.indices, 1))
  geometry.computeBoundingSphere()
  const mesh = new THREE.Mesh(geometry)
  const t0 = Date.now()
  const res = threeToSoloNavMesh([mesh], { ...config, bounds: geom.bounds })
  geometry.dispose()
  const ms = Date.now() - t0
  if (!res.success) return { success: false, error: res.error || 'navmesh build failed', ms }

  let pruned = false
  if (pruneFrom) {
    try {
      const query = new NavMeshQuery(res.navMesh)
      const near = query.findNearestPoly(
        { x: pruneFrom[0], y: 0, z: pruneFrom[1] },
        { halfExtents: { x: 30, y: 6, z: 30 } },
      )
      if (near.success && near.nearestRef) {
        floodFillPruneNavMesh(res.navMesh, [near.nearestRef])
        pruned = true
      }
    } catch (e) {
      /* best-effort: an unpruned mesh still paths correctly */
    }
  }
  return { success: true, navMesh: res.navMesh, ms, pruned }
}

/** Triangle count of the generated mesh (QA / HUD). */
export const navMeshPolyCount = (navMesh) => {
  try {
    const [, indices] = getNavMeshPositionsAndIndices(navMesh)
    return indices.length / 3
  } catch (e) {
    return 0
  }
}

/** Flat positions + indices for the debug wireframe (world space). */
export const navMeshGeometryData = (navMesh) => getNavMeshPositionsAndIndices(navMesh)

/* ------------------------------------------------------------------ */
/* queries                                                             */
/* ------------------------------------------------------------------ */

/** Length of a [[x, z], ...] polyline in metres. */
export const pathLength = (points) => {
  let len = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    len += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])
  }
  return len
}

export const createNavQuery = (navMesh, params) => new NavMeshQuery(navMesh, params)

const EMPTY_PATH = { points: [], length: 0, found: false }

/**
 * Straight path between two world XZ points, string-pulled by Detour and
 * returned as [[x, z], ...]. Off-mesh endpoints are snapped to the nearest
 * poly, so callers can pass an entity position directly. Never throws: a bad
 * query returns `found: false` rather than trapping the wasm module.
 */
export const navPath = (
  query,
  from,
  to,
  { halfExtents = { x: 3, y: 6, z: 3 }, maxPathPolys = 256 } = {},
) => {
  try {
    const r = query.computePath(
      { x: from[0], y: 0, z: from[1] },
      { x: to[0], y: 0, z: to[1] },
      { halfExtents, maxPathPolys },
    )
    if (!r.success || !r.path || r.path.length === 0) return EMPTY_PATH
    const points = r.path.map((p) => [p.x, p.z])
    return { points, length: pathLength(points), found: true }
  } catch (e) {
    return EMPTY_PATH
  }
}

/**
 * Point at arc length `s` along a polyline, plus the tangent heading (radians,
 * `atan2(dx, dz)` — the yaw basis the cars and peds already use). Writes into
 * `out` so a per-frame follower allocates nothing.
 */
export const samplePath = (points, s, out = { x: 0, z: 0, yaw: 0, done: true }) => {
  if (!points || points.length === 0) return out
  if (points.length === 1) {
    out.x = points[0][0]
    out.z = points[0][1]
    out.done = true
    return out
  }
  let left = Math.max(0, s)
  for (let i = 0; i < points.length - 1; i += 1) {
    const ax = points[i][0]
    const az = points[i][1]
    const dx = points[i + 1][0] - ax
    const dz = points[i + 1][1] - az
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) continue
    if (left <= len) {
      const t = left / len
      out.x = ax + dx * t
      out.z = az + dz * t
      out.yaw = Math.atan2(dx, dz)
      out.done = false
      return out
    }
    left -= len
  }
  const n = points.length - 1
  const last = points[n]
  out.x = last[0]
  out.z = last[1]
  out.yaw = Math.atan2(last[0] - points[n - 1][0], last[1] - points[n - 1][1])
  out.done = true
  return out
}

/**
 * Nearest point actually ON the mesh, or null.
 *
 * `findNearestPoly` reports `success: true` even when it finds NOTHING — it
 * returns `nearestRef: 0` plus an *uninitialized* `nearestPoint`, which reads
 * back as denormal garbage like `2.589599562072262e-41` instead of throwing. So
 * `success` alone is not a usable check: anything that trusted it would place
 * agents at (0, 0). Detour never issues poly ref 0, so `nearestRef` is the real
 * gate. (`scripts/navmesh-repro.mjs` T5 is what caught this.)
 */
export const navNearest = (query, x, z, halfExtents = { x: 3, y: 6, z: 3 }) => {
  try {
    const r = query.findNearestPoly({ x, y: 0, z }, { halfExtents })
    if (!r.success || !r.nearestRef) return null
    const p = r.nearestPoint
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
    return { x: p.x, y: p.y, z: p.z, ref: r.nearestRef, onMesh: r.isOverPoly }
  } catch (e) {
    return null
  }
}

/**
 * Deterministic random walkable point within `radius` of (x, z) — the ped
 * wander target. Seeded, so a given ped always walks the same route for a given
 * seed (keeps spawns/tests reproducible).
 */
export const navRandomPointAround = (query, x, z, radius, seed = 1) => {
  try {
    setRandomSeed(seed)
    const r = query.findRandomPointAroundCircle(
      { x, y: 0, z },
      radius,
      { halfExtents: { x: radius + 3, y: 6, z: radius + 3 } },
    )
    if (!r.success) return null
    return { x: r.randomPoint.x, z: r.randomPoint.z, ref: r.randomPolyRef }
  } catch (e) {
    return null
  }
}

/** A Crowd bound to `navMesh`; the caller owns update()/destroy(). */
export const createCrowd = (navMesh, { maxAgents = 64, maxAgentRadius = 0.6 } = {}) =>
  new Crowd(navMesh, { maxAgents, maxAgentRadius })

export const disposeNavMesh = (navMesh) => {
  try {
    navMesh?.destroy?.()
  } catch (e) {
    /* already gone */
  }
}
