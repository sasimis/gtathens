// Road-graph A* — the CARS half of the navigation story.
//
// Cars must NOT use the pedestrian navmesh: a navmesh describes walkable ground,
// not lanes, one-way flow, or "stay on the asphalt". GTA-style traffic follows
// road SPLINES, and those splines are already in the world as the OSM ways
// Roads.jsx draws and `worldData.buildSegments()` hands out. So this module turns
// those segments into a routable graph and answers "what is the driving route
// from A to B" with A*.
//
// Why it does not reuse `worldData.buildRoadGraph()`: that one exists for
// random-walking AI traffic (a Map of object references). Routing wants integer
// ids, flat arrays, a spatial index for snapping and junction stitching — see
// `stitch`, which is what makes routing work at all on OSM data. The segment
// format it consumes is identical, so the two stay consistent.
//
// Plain JS, no wasm, no React, no three.js: runs in the browser and in Node
// (`scripts/roadpath-repro.mjs`).
import { DRIVABLE, WALKABLE, buildSegments, hash01 } from './worldData.js'

/** Reusable filter sets, keyed for the module-level cache. */
export const ROAD_FILTERS = {
  drivable: DRIVABLE,
  walkable: WALKABLE,
}

/**
 * Nodes this close together are treated as one junction and connected.
 *
 * OSM ways that cross usually share a node, but NOT in this map crop: the ways
 * are drawn independently, so junctions meet at 2-10 m gaps (scripts/
 * navmesh-probe measurements: 78 of 276 drivable nodes have their nearest
 * foreign node 2-5 m away, 114 at 5-10 m). A 2 m radius stitched 5 pairs and
 * left the graph 27.9% connected — cross-town routes failed. A radius sweep
 * over the real data (see roadpath-repro.mjs T8):
 *
 *   r=2  27.9%   r=4  92.8%   r=8  97.8%   r=10  98.6%   r=12  99.3%
 *
 * 8 m gives 43 stitched edges and 97.8% connectivity; going to 12-15 m adds
 * roughly double the stitches for +1.5% (parallel roads joining each other —
 * false junctions that let traffic cut across). The residual ~2% are genuinely
 * isolated service/driveway ways with nothing within 15 m to join.
 *
 * Junction plausibility was spot-checked: stitched pairs at r=8 show collinear
 * continuations (~0 deg heading delta), crossroads (~90 deg) and turns — the
 * shape of real junctions, not lane-for-lane parallel merges.
 */
export const STITCH_R = 8.0

/**
 * Cost multiplier for stitched (junction-guess) edges in A*'s g-score.
 * Stitches bridge OSM ways that meet at a gap — usually real junctions, but
 * occasionally a lane-for-lane parallel merge or a driveway hop. A small
 * penalty makes A* prefer real road segments when both exist, while still
 * routing across stitches where they are the only connection. Applied to the
 * CSR g-cost only; reported route lengths stay true metres
 * (polylineLength over node coordinates).
 */
export const STITCH_COST_MUL = 1.25

/** Node identity: 0.1 m grid — same recipe (and tolerance) as buildRoadGraph. */
const nodeKey = (x, z) => `${Math.round(x * 10)},${Math.round(z * 10)}`

/* ------------------------------------------------------------------ */
/* binary min-heap on the f-score                                      */
/* ------------------------------------------------------------------ */

class MinHeap {
  constructor(capacity = 1024) {
    this.ids = new Int32Array(capacity)
    this.keys = new Float64Array(capacity)
    this.size = 0
  }

  clear() {
    this.size = 0
  }

  push(id, key) {
    if (this.size >= this.ids.length) {
      const cap = this.ids.length * 2
      const ids = new Int32Array(cap)
      const keys = new Float64Array(cap)
      ids.set(this.ids)
      keys.set(this.keys)
      this.ids = ids
      this.keys = keys
    }
    let i = this.size
    this.size += 1
    this.ids[i] = id
    this.keys[i] = key
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.keys[parent] <= this.keys[i]) break
      this.swap(parent, i)
      i = parent
    }
  }

  pop() {
    if (this.size === 0) return -1
    const top = this.ids[0]
    this.size -= 1
    if (this.size > 0) {
      this.ids[0] = this.ids[this.size]
      this.keys[0] = this.keys[this.size]
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < this.size && this.keys[l] < this.keys[m]) m = l
        if (r < this.size && this.keys[r] < this.keys[m]) m = r
        if (m === i) break
        this.swap(m, i)
        i = m
      }
    }
    return top
  }

  swap(a, b) {
    const ti = this.ids[a]
    this.ids[a] = this.ids[b]
    this.ids[b] = ti
    const tk = this.keys[a]
    this.keys[a] = this.keys[b]
    this.keys[b] = tk
  }
}

/* ------------------------------------------------------------------ */
/* A* over that graph                                                  */
/* ------------------------------------------------------------------ */

/**
 * Euclidean-distance heuristic (admissible: edge costs are metres, so the
 * straight line never overestimates). An earlier squared-distance version
 * looked "faster" (fewer expansions, no sqrt) but for any distance > 1 m
 * d^2 > d, i.e. it OVERESTIMATES — A* degrades to greedy best-first and can
 * return suboptimal routes. One hypot per expansion is negligible next to
 * heap work; keep this admissible.
 */
const heuristic = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz)

/** Length of a [[x, z], ...] polyline in metres (the route's driving distance). */
export const polylineLength = (points) => {
  let len = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    len += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1])
  }
  return len
}

/**
 * Point at arc length `s` along a route, plus the tangent heading
 * (`atan2(dx, dz)` — the yaw basis the cars use). Writes into `out`, so a car
 * following a route per frame allocates nothing.
 */
export const sampleRoute = (points, s, out = { x: 0, z: 0, yaw: 0, done: true }) => {
  if (!points || points.length === 0) return out
  const n = points.length
  if (n === 1) {
    out.x = points[0][0]
    out.z = points[0][1]
    out.done = true
    return out
  }
  let left = Math.max(0, s)
  for (let i = 0; i < n - 1; i += 1) {
    const ax = points[i][0]
    const az = points[i][1]
    const dx = points[i + 1][0] - ax
    const dz = points[i + 1][1] - az
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) continue
    if (left <= len) {
      out.x = ax + dx * (left / len)
      out.z = az + dz * (left / len)
      out.yaw = Math.atan2(dx, dz)
      out.done = false
      return out
    }
    left -= len
  }
  out.x = points[n - 1][0]
  out.z = points[n - 1][1]
  out.yaw = Math.atan2(points[n - 1][0] - points[n - 2][0], points[n - 1][1] - points[n - 2][1])
  out.done = true
  return out
}

/**
 * A* with a visit-token trick instead of clearing arrays per query: `gScore` is
 * only trusted where `visitToken === token`, so a fresh query costs O(1) setup
 * and a repeated query allocates nothing.
 */
const astarApi = ({ nx, nz, adjStart, adjTo, adjLen, count, nearest }) => {
  const gScore = new Float64Array(count)
  const visitToken = new Int32Array(count)
  const closedToken = new Int32Array(count)
  const cameFrom = new Int32Array(count)
  const heap = new MinHeap()
  let token = 0

  /** Walks `cameFrom` back from `goal` and returns [[x, z], ...]. */
  const reconstruct = (goal, start) => {
    const out = []
    let cur = goal
    let guard = 0
    while (cur !== -1 && guard < count + 4) {
      out.push([nx[cur], nz[cur]])
      if (cur === start) break
      cur = cameFrom[cur]
      guard += 1
    }
    out.reverse()
    return out
  }

  /**
   * Drivable route between two world XZ points.
   *
   * Endpoints are SNAPPED to the nearest graph node (0.1 m node grid, so up to
   * about half a segment of slop on a coarse OSM way) — the returned polyline
   * runs node-to-node along real roads, which is exactly what a car follows.
   *
   * When the goal is unreachable (a disconnected island, a one-way pocket) the
   * search does not give up empty-handed: it returns `partial: true` with the
   * route to the node that got closest to the goal. A caller that needs a strict
   * answer must check `found`.
   */
  const findPath = (from, to, { maxExpansions = 200000 } = {}) => {
    const a = nearest(from[0], from[1])
    const b = nearest(to[0], to[1])
    if (!a || !b) return { found: false, partial: false, points: [], length: 0, nodes: 0 }
    if (a.id === b.id) {
      return {
        found: true,
        partial: false,
        points: [[a.x, a.z]],
        length: 0,
        nodes: 1,
        from: a,
        to: b,
      }
    }

    token += 1
    heap.clear()
    visitToken[a.id] = token
    gScore[a.id] = 0
    cameFrom[a.id] = -1
    heap.push(a.id, heuristic(a.x, a.z, b.x, b.z))

    let best = a.id
    let bestH = heuristic(a.x, a.z, b.x, b.z)
    let expanded = 0
    while (heap.size > 0 && expanded < maxExpansions) {
      const cur = heap.pop()
      if (closedToken[cur] === token) continue // stale heap entry
      closedToken[cur] = token
      expanded += 1

      const h = heuristic(nx[cur], nz[cur], b.x, b.z)
      if (h < bestH) {
        bestH = h
        best = cur
      }
      if (cur === b.id) {
        best = cur
        break
      }

      const end = adjStart[cur + 1]
      for (let e = adjStart[cur]; e < end; e += 1) {
        const nb = adjTo[e]
        if (closedToken[nb] === token) continue
        const tentative = gScore[cur] + adjLen[e]
        if (visitToken[nb] !== token || tentative < gScore[nb]) {
          visitToken[nb] = token
          gScore[nb] = tentative
          cameFrom[nb] = cur
          heap.push(nb, tentative + heuristic(nx[nb], nz[nb], b.x, b.z))
        }
      }
    }

    const found = best === b.id
    const points = reconstruct(best, a.id)
    return {
      found,
      partial: !found,
      points,
      length: polylineLength(points),
      nodes: points.length,
      from: a,
      to: b,
      expanded,
      // How far the goal still is when unreachable, in metres.
      goalDist: Math.hypot(nx[best] - b.x, nz[best] - b.z),
    }
  }

  /**
   * Deterministic round-trip route for AI traffic: two nodes picked by `seed`,
   * routed with A*, then routed back. `hash01` keeps it reproducible, so a given
   * traffic car laps the same circuit every session.
   */
  const randomRoute = (seed, { minLen = 80, maxLen = 300 } = {}) => {
    if (count < 4) return null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const si = Math.floor(hash01(seed * 131 + attempt * 17 + 7) * count) % count
      const ti = Math.floor(hash01(seed * 977 + attempt * 61 + 3) * count) % count
      const out = findPath([nx[si], nz[si]], [nx[ti], nz[ti]])
      if (!out.found || out.points.length < 3) continue
      if (out.length < minLen || out.length > maxLen) continue
      const back = findPath([nx[ti], nz[ti]], [nx[si], nz[si]])
      if (!back.found) continue
      // Close the loop: forward points, then the return leg minus its first
      // point (it duplicates the forward leg's last).
      const loop = out.points.concat(back.points.slice(1))
      return { points: loop, length: out.length + back.length, outbound: out, inbound: back }
    }
    return null
  }

  return { findPath, randomRoute, _internals: { gScore, heap, token: () => token } }
}

/* ------------------------------------------------------------------ */
/* graph building                                                      */
/* ------------------------------------------------------------------ */

/**
 * Builds a routable graph from road segments ({ax, az, bx, bz, len}).
 *
 * Returns a pathfinder: `findPath(from, to)`, `nearest(x, z)`, `randomRoute()`,
 * `stats()`, plus the raw arrays for renderers (the GPS/minimap line just reads
 * `nx`/`nz` through the path points).
 */
export const buildRoadPathfinder = (segments, { stitch = STITCH_R } = {}) => {
  // --- nodes, deduped on a 0.1 m grid ---
  const index = new Map()
  const nx = []
  const nz = []
  const nodeOf = (x, z) => {
    const k = nodeKey(x, z)
    let i = index.get(k)
    if (i === undefined) {
      i = nx.length
      index.set(k, i)
      nx.push(x)
      nz.push(z)
    }
    return i
  }

  // --- edges, deduped as unordered pairs ---
  const edgeList = []
  const seen = new Set()
  const addEdge = (a, b, len, kind) => {
    if (a === b) return false
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    const k = `${lo}:${hi}`
    if (seen.has(k)) return false
    seen.add(k)
    edgeList.push({ a, b, len, kind })
    return true
  }

  for (const s of segments) {
    if (!Number.isFinite(s.ax) || !Number.isFinite(s.az)) continue
    if (!Number.isFinite(s.bx) || !Number.isFinite(s.bz)) continue
    const a = nodeOf(s.ax, s.az)
    const b = nodeOf(s.bx, s.bz)
    const len = Number.isFinite(s.len) && s.len > 0
      ? s.len
      : Math.hypot(s.bx - s.ax, s.bz - s.az)
    addEdge(a, b, len, 'segment')
  }

  const segmentEdges = edgeList.length

  // --- stitching: connect near-coincident nodes from different ways ---
  const cell = Math.max(stitch, 1)
  const buckets = new Map()
  for (let i = 0; i < nx.length; i += 1) {
    const k = `${Math.floor(nx[i] / cell)},${Math.floor(nz[i] / cell)}`
    let arr = buckets.get(k)
    if (!arr) {
      arr = []
      buckets.set(k, arr)
    }
    arr.push(i)
  }
  let stitched = 0
  if (stitch > 0) {
    for (let i = 0; i < nx.length; i += 1) {
      const cx = Math.floor(nx[i] / cell)
      const cz = Math.floor(nz[i] / cell)
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oz = -1; oz <= 1; oz += 1) {
          const arr = buckets.get(`${cx + ox},${cz + oz}`)
          if (!arr) continue
          for (const j of arr) {
            if (j <= i) continue
            const d = Math.hypot(nx[j] - nx[i], nz[j] - nz[i])
            if (d > 0 && d <= stitch && addEdge(i, j, d * STITCH_COST_MUL, 'stitch')) stitched += 1
          }
        }
      }
    }
  }

  // --- CSR adjacency: flat arrays, so A* never touches per-node objects ---
  const count = nx.length
  const degree = new Int32Array(count)
  for (const e of edgeList) {
    degree[e.a] += 1
    degree[e.b] += 1
  }
  const adjStart = new Int32Array(count + 1)
  for (let i = 0; i < count; i += 1) adjStart[i + 1] = adjStart[i] + degree[i]
  const adjTo = new Int32Array(edgeList.length * 2)
  const adjLen = new Float64Array(edgeList.length * 2)
  const cursor = adjStart.slice(0, count)
  for (const e of edgeList) {
    adjTo[cursor[e.a]] = e.b
    adjLen[cursor[e.a]] = e.len
    cursor[e.a] += 1
    adjTo[cursor[e.b]] = e.a
    adjLen[cursor[e.b]] = e.len
    cursor[e.b] += 1
  }

  // --- spatial index over nodes, for snapping (8 m buckets) ---
  const nCell = 8
  const grid = new Map()
  for (let i = 0; i < count; i += 1) {
    const k = `${Math.floor(nx[i] / nCell)},${Math.floor(nz[i] / nCell)}`
    let arr = grid.get(k)
    if (!arr) {
      arr = []
      grid.set(k, arr)
    }
    arr.push(i)
  }

  /** Nearest graph node to (x, z); ring search first, full scan as backstop. */
  const nearest = (x, z, maxSearch = 48) => {
    let best = -1
    let bestD = Infinity
    const cx = Math.floor(x / nCell)
    const cz = Math.floor(z / nCell)
    const rings = Math.ceil(maxSearch / nCell)
    for (let ring = 0; ring <= rings; ring += 1) {
      for (let ox = -ring; ox <= ring; ox += 1) {
        for (let oz = -ring; oz <= ring; oz += 1) {
          // Perimeter only: inner cells were covered by earlier rings.
          if (ring > 0 && Math.abs(ox) !== ring && Math.abs(oz) !== ring) continue
          const arr = grid.get(`${cx + ox},${cz + oz}`)
          if (!arr) continue
          for (const i of arr) {
            const d = (nx[i] - x) * (nx[i] - x) + (nz[i] - z) * (nz[i] - z)
            if (d < bestD) {
              bestD = d
              best = i
            }
          }
        }
      }
      // A ring that starts farther than the best hit cannot improve it.
      if (best >= 0 && (ring + 1) * nCell > Math.sqrt(bestD)) break
    }
    if (best < 0) {
      for (let i = 0; i < count; i += 1) {
        const d = (nx[i] - x) * (nx[i] - x) + (nz[i] - z) * (nz[i] - z)
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
    }
    if (best < 0) return null
    return { id: best, x: nx[best], z: nz[best], dist: Math.sqrt(bestD) }
  }

  return {
    size: count,
    nx,
    nz,
    edgeList,
    adjStart,
    adjTo,
    adjLen,
    stitched,
    nearest,
    ...astarApi({ nx, nz, adjStart, adjTo, adjLen, count, nearest }),
    stats: () => ({
      nodes: count,
      edges: edgeList.length,
      segmentEdges,
      stitched,
      avgDegree: count === 0 ? 0 : (edgeList.length * 2) / count,
    }),
  }
}

/* ------------------------------------------------------------------ */
/* shared instance + QA seam                                           */
/* ------------------------------------------------------------------ */

/**
 * One pathfinder per (world data, filter) pair, built on first use.
 *
 * Keyed on the DATA OBJECT via WeakMap, not on a name: `loadWorldData()` hands
 * out the same cached object to every caller, so NPCs, traffic and any future
 * GPS/minimap share one graph — and re-entering the game reuses it instead of
 * re-routing 266 ways.
 */
const cache = new WeakMap()
let current = null

export const getRoadPathfinder = (data, filterKey = 'drivable') => {
  if (!data) return null
  let byFilter = cache.get(data)
  if (!byFilter) {
    byFilter = new Map()
    cache.set(data, byFilter)
  }
  let pf = byFilter.get(filterKey)
  if (!pf) {
    const filter = ROAD_FILTERS[filterKey] || DRIVABLE
    pf = buildRoadPathfinder(buildSegments(data, (t) => filter.has(t)))
    byFilter.set(filterKey, pf)
    current = pf
    byFilter.set('__data', data)
  }
  current = pf
  return pf
}

/**
 * QA seam for scripts/smoke.mjs (mirrors window.__gtathensCars / __gtathensNpcs):
 * a stable object whose methods return plain numbers, so the headless test can
 * assert that real OSM roads route end-to-end without touching React. Installed
 * at module scope; methods no-op until a graph has been built.
 */
export const roadNavQA = {
  ready: () => current !== null,
  stats: () => (current ? current.stats() : null),
  route: (x1, z1, x2, z2) => {
    if (!current) return null
    const r = current.findPath([x1, z1], [x2, z2])
    return {
      found: r.found,
      partial: r.partial,
      length: Number(r.length.toFixed(2)),
      nodes: r.nodes,
      expanded: r.expanded,
      goalDist: Number(r.goalDist.toFixed(2)),
      // Compact enough to print in a report, long enough to see the shape.
      first: r.points.slice(0, 3).map((p) => [Number(p[0].toFixed(1)), Number(p[1].toFixed(1))]),
      last: r.points.slice(-3).map((p) => [Number(p[0].toFixed(1)), Number(p[1].toFixed(1))]),
    }
  },
  nearest: (x, z) => {
    if (!current) return null
    const n = current.nearest(x, z)
    return n ? { id: n.id, x: Number(n.x.toFixed(2)), z: Number(n.z.toFixed(2)), dist: Number(n.dist.toFixed(2)) } : null
  },
  randomRoute: (seed) => {
    if (!current) return null
    const r = current.randomRoute(seed)
    return r ? { length: Number(r.length.toFixed(1)), nodes: r.points.length, closed: true } : null
  },
  /** Fraction of nodes in the largest connected component (1.0 = fully joined). */
  connectivity: () => {
    if (!current) return 0
    const { adjStart, adjTo, size } = current
    if (size === 0) return 0
    const seen = new Uint8Array(size)
    let largest = 0
    const stack = []
    for (let s = 0; s < size; s += 1) {
      if (seen[s]) continue
      let n = 0
      stack.length = 0
      stack.push(s)
      seen[s] = 1
      while (stack.length) {
        const cur = stack.pop()
        n += 1
        for (let e = adjStart[cur]; e < adjStart[cur + 1]; e += 1) {
          const nb = adjTo[e]
          if (!seen[nb]) {
            seen[nb] = 1
            stack.push(nb)
          }
        }
      }
      if (n > largest) largest = n
    }
    return largest / size
  },
}

if (typeof window !== 'undefined') window.__gtathensRoadNav = roadNavQA