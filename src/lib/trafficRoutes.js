// AI-traffic route PLANNING — the FLEET half of the navigation story.
//
// RoadPathfinder answers "how do I drive from A to B" (one car, one trip).
// The city traffic needs two more questions answered:
//
//   1. Which `count` closed loops should the fleet lap so DISTINCT ROADS all
//      over the map get used — not the same few favourite circuits — and so
//      the cars SPAWN spread across the city instead of clumping?
//        -> planCoverageRoutes(pf, count)
//
//   2. Where should a car go when it finishes a lap? Re-plan from where the
//      car IS now toward a part of the graph the fleet has used least, and
//      close the loop back — so traffic keeps flowing onto new streets
//      forever instead of repeating one circuit.
//        -> rerouteLoop(pf, x, z, opts)
//
// Both share ONE edge-usage registry per pathfinder (WeakMap, keyed on the
// very object getRoadPathfinder caches), so the initial plan and every
// reroute bias the fleet onto roads it has not driven yet. That is what
// "traffic on every road" means here: measured, incremental coverage of the
// graph's edge set (drivable segments + junction stitches).
//
// Plain JS — no React / three / wasm — so scripts/traffic-routes-repro.mjs
// runs the REAL planner in Node against the REAL public/map_data.json.
import { hash01 } from './worldData.js'

/** pf -> Set<"lo:hi"> node-id pairs of graph edges the fleet has used. */
const usage = new WeakMap()

const usageFor = (pf) => {
  let s = usage.get(pf)
  if (!s) {
    s = new Set()
    usage.set(pf, s)
  }
  return s
}

/** Node ids along a [[x, z], ...] polyline (route points ARE graph nodes). */
const idsOf = (pf, points) => {
  const ids = new Array(points.length)
  for (let i = 0; i < points.length; i += 1) {
    const n = pf.nearest(points[i][0], points[i][1])
    ids[i] = n ? n.id : -1
  }
  return ids
}

/**
 * Canonical "lo:hi" keys for consecutive node ids (undirected edges — the
 * same canonicalisation buildRoadPathfinder's edge dedup uses, so keys are
 * directly comparable with pf.edgeList).
 */
const edgeKeysOf = (ids) => {
  const keys = []
  for (let i = 0; i < ids.length - 1; i += 1) {
    const a = ids[i]
    const b = ids[i + 1]
    if (a < 0 || b < 0 || a === b) continue
    keys.push(a < b ? `${a}:${b}` : `${b}:${a}`)
  }
  return keys
}

/**
 * Distinct-road coverage of a set of routes: how many of the graph's edges
 * (every drivable segment + stitch) appear in at least one route.
 * Returns { edges, covered, fraction } — fraction 1.0 means every routable
 * road in the city is on some car's loop.
 */

/**
 * Pick `count` closed loops that together cover as MANY DISTINCT ROADS as
 * possible, with spawn points spread across the city.
 *
 * How: build a pool of candidate loops with pf.randomRoute (mixed compact
 * errand / long arterial length profiles, de-duped by edge signature), then
 * greedily pick one loop per car with
 *
 *   score = 2 * (edges not yet covered)         — "drive roads we missed"
 *         + 0.12 * min dist to picked starts    — "spawn spread out"
 *         + small deterministic jitter          — stable tie-breaks
 *
 * Deterministic for a given (pf, count, seedBase): same fleet every session.
 * The picked edges register into the shared usage set, which then biases
 * each car's per-lap rerouteLoop() away from what this plan already covers.
 *
 * Returns [[x, z], ...] loops (first point === last point, closed). May be
 * shorter than `count` if the graph cannot yield that many distinct circuits;
 * callers fall back to the legacy walker when EMPTY.
 */
export const planCoverageRoutes = (pf, count, { seedBase = 13 } = {}) => {
  if (!pf || pf.size < 4 || count <= 0) return []

  // --- candidate pool: mixed profiles so coverage isn't all side streets
  // (or all ring roads). 1.5x seeds leave headroom for dupes/fails.
  const target = count * 4
  const pool = []
  const sigs = new Set()
  const seedCount = Math.ceil(target * 1.5)
  for (let c = 0; c < seedCount && pool.length < target; c += 1) {
    const seed = seedBase + c * 977
    const opts = c % 3 === 2 ? { minLen: 150, maxLen: 520 } : { minLen: 70, maxLen: 300 }
    let r = null
    try {
      r = pf.randomRoute(seed, opts)
    } catch (e) {
      r = null
    }
    if (!r || r.points.length < 3) continue
    const keys = edgeKeysOf(idsOf(pf, r.points))
    if (keys.length === 0) continue
    // Same road set (either driving direction) = same circuit.
    const sig = keys.slice().sort().join('|')
    if (sigs.has(sig)) continue
    sigs.add(sig)
    pool.push({ points: r.points, keys })
  }

  // --- greedy pick: new-edge coverage dominates, spread breaks clumps
  const used = new Set()
  const picked = []
  const starts = []
  while (picked.length < count && pool.length > 0) {
    let bi = -1
    let bScore = -Infinity
    for (let j = 0; j < pool.length; j += 1) {
      const cand = pool[j]
      let newE = 0
      for (let k = 0; k < cand.keys.length; k += 1) {
        if (!used.has(cand.keys[k])) newE += 1
      }
      let spread = 24 // first pick: neutral, no starts yet
      if (starts.length > 0) {
        let dMin = Infinity
        for (let q = 0; q < starts.length; q += 1) {
          const d = Math.hypot(cand.points[0][0] - starts[q][0], cand.points[0][1] - starts[q][1])
          if (d < dMin) dMin = d
        }
        spread = Math.min(200, dMin) * 0.12
      }
      const score = newE * 2 + spread + hash01(cand.keys.length * 31 + picked.length * 7 + j) * 0.5
      if (score > bScore) {
        bScore = score
        bi = j
      }
    }
    if (bi < 0) break
    const best = pool.splice(bi, 1)[0]
    picked.push(best.points)
    starts.push(best.points[0])
    for (let k = 0; k < best.keys.length; k += 1) used.add(best.keys[k])
  }

  // Register for rerouteLoop's unvisited-road bias (accumulates across
  // remounts on purpose: a second session keeps exploring, not repeating).
  const reg = usageFor(pf)
  for (const k of used) reg.add(k)
  return picked
}

/**
 * New closed loop for a car standing at (x, z): A* from the car's nearest
 * junction to a goal node, then A* back — same shape randomRoute produces
 * (first point === last point, so the caller's wrap logic is unchanged).
 *
 * Goal candidates are sampled deterministically from `seed` and SCORED by
 * how many of the resulting loop's edges the shared registry has NOT seen
 * yet, so completed laps push traffic onto unvisited roads. Returns the
 * loop, or null when no sane goal exists (caller keeps the old loop — a
 * failed re-plan must never strand the car).
 *
 * Note the loop starts at the NEAREST JUNCTION to (x, z), which on long OSM
 * segments can be up to half a segment away — callers must re-project their
 * progress with a FULL-route scan (findNearestOnRoute), not a small window.
 */
export const rerouteLoop = (
  pf,
  x,
  z,
  { seed = 1, tries = 10, minGoal = 80, maxGoal = 420, minLen = 70, maxLen = 650 } = {},
) => {
  if (!pf || pf.size < 4) return null
  const reg = usageFor(pf)
  let best = null
  let bestScore = -Infinity
  for (let t = 0; t < tries; t += 1) {
    const gi = Math.floor(hash01(seed * 131 + t * 17 + 3) * pf.size) % pf.size
    const gx = pf.nx[gi]
    const gz = pf.nz[gi]
    const gd = Math.hypot(gx - x, gz - z)
    if (gd < minGoal || gd > maxGoal) continue
    let out = null
    let back = null
    try {
      out = pf.findPath([x, z], [gx, gz])
      if (!out.found || out.points.length < 3) continue
      if (out.length < minLen || out.length > maxLen) continue
      back = pf.findPath([gx, gz], [out.points[0][0], out.points[0][1]])
      if (!back.found) continue
    } catch (e) {
      continue
    }
    const loop = out.points.concat(back.points.slice(1))
    const keys = edgeKeysOf(idsOf(pf, loop))
    let fresh = 0
    for (let k = 0; k < keys.length; k += 1) {
      if (!reg.has(keys[k])) fresh += 1
    }
    // Unseen roads dominate; deterministic jitter diversifies ties per seed.
    const score = fresh * 2 + hash01(seed * 977 + t * 61) * 0.5
    if (score > bestScore) {
      bestScore = score
      best = { loop, keys }
    }
  }
  if (!best) return null
  for (let k = 0; k < best.keys.length; k += 1) reg.add(best.keys[k])
  return best.loop
}


export const coverageOf = (pf, routes) => {
  const seen = new Set()
  for (const r of routes || []) {
    if (!r || r.length < 2) continue
    const keys = edgeKeysOf(idsOf(pf, r))
    for (let i = 0; i < keys.length; i += 1) seen.add(keys[i])
  }
  const edges = pf && pf.edgeList ? pf.edgeList.length : 0
  return { edges, covered: seen.size, fraction: edges > 0 ? seen.size / edges : 0 }
}

/** Edges in the shared usage registry — harness/QA observability (T6). */
export const usageSize = (pf) => {
  const s = pf ? usage.get(pf) : null
  return s ? s.size : 0
}
