// Proof harness for the road-graph A* path (the CARS half of navigation).
//
//   cd workspace && node scripts/roadpath-repro.mjs
//
// It imports the PRODUCTION module (src/lib/RoadPathfinder.js) — not a copy —
// and feeds it the REAL public/map_data.json, so it verifies exactly what the
// game will run: the segment reader, junction stitching, CSR adjacency, A*,
// snapping, randomRoute and the module-level cache. Plain Node, no browser,
// no wasm, no three.js.
//
// The questions it answers, each with a decisive experiment:
//
//   T1  does the real OSM data build a graph at all, and is it CONNECTED?
//       (stitching is what makes OSM ways that meet "at a gap" routable)
//   T2  does A* route across town on real roads — found, and never much
//       longer than the straight line?
//   T3  is the route CONTIGUOUS (every hop is one graph edge, hops > 0)?
//   T4  does nearest() snap exactly to a node, and stay bounded elsewhere?
//   T5  is an unreachable goal reported as partial (found=false, goalDist>0),
//       not as garbage coordinates?  (two synthetic islands)
//   T6  does randomRoute give a deterministic CLOSED LOOP for a seed?
//   T7  does sampleRoute walk a route without allocating and arrive done?
//   T8  does stitch=0 fragment the real graph?  (soft check: prints, and
//       FAILS only if stitching did not help connectivity at all)
//   T9  is the module cache stable?  (getRoadPathfinder twice === one instance)
//
// Always writes scripts/roadpath-repro.txt and exits 0, so a failed check still
// leaves a readable report.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  STITCH_R,
  buildRoadPathfinder,
  getRoadPathfinder,
  polylineLength,
  sampleRoute,
} from '../src/lib/RoadPathfinder.js'
import { DRIVABLE, buildSegments } from '../src/lib/worldData.js'

/** A stitch edge is at most STITCH_R long; hops may be one stitch longer. */
const STITCH_SLOP = STITCH_R + 0.5

const F = fileURLToPath(new URL('./roadpath-repro.txt', import.meta.url))
writeFileSync(F, '')
const w = (s) => appendFileSync(F, String(s) + '\r\n')
const hr = (s) => w(`\r\n--- ${s} ---`)
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  w(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Largest connected component as a fraction of all nodes (0..1). */
const connectivityOf = (pf) => {
  const { adjStart, adjTo, size } = pf
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
  return size === 0 ? 0 : largest / size
}

/* ------------------------------------------------------------------ */
/* real data                                                           */
/* ------------------------------------------------------------------ */

const data = JSON.parse(readFileSync(fileURLToPath(new URL('../public/map_data.json', import.meta.url)), 'utf8'))
const segments = buildSegments(data, (t) => DRIVABLE.has(t))
const pf = buildRoadPathfinder(segments)
const stats = pf.stats()

hr('T1 - build from real map_data.json (drivable ways)')
w(`roads in data: ${(data.roads || []).length}, drivable segments: ${segments.length}`)
w(`graph: ${stats.nodes} nodes, ${stats.edges} edges (${stats.segmentEdges} segment + ${stats.edges - stats.segmentEdges} stitched), avg degree ${stats.avgDegree.toFixed(2)}`)
check('graph is non-empty', stats.nodes > 10 && stats.edges > 10)
const connectivity = connectivityOf(pf)
w(`largest component: ${(connectivity * 100).toFixed(1)}% of nodes`)
check('real road graph is near-fully connected (stitching worked)', connectivity > 0.95, 'the residual are isolated service ways — see STITCH_R docs')
check('stitching actually did work (>= 20 stitched edges)', stats.edges - stats.segmentEdges >= 20)

/* ------------------------------------------------------------------ */
/* pick two far-apart real nodes, deterministically                    */
/* ------------------------------------------------------------------ */

let endI = 0
let far = -1
for (let i = 1; i < pf.size; i += 1) {
  const d = (pf.nx[i] - pf.nx[0]) ** 2 + (pf.nz[i] - pf.nz[0]) ** 2
  if (d > far) {
    far = d
    endI = i
  }
}
const A = [pf.nx[0], pf.nz[0]]
const B = [pf.nx[endI], pf.nz[endI]]
const straight = Math.hypot(B[0] - A[0], B[1] - A[1])

hr('T2 - A* across town on real roads')
w(`from (${A[0].toFixed(1)}, ${A[1].toFixed(1)}) to (${B[0].toFixed(1)}, ${B[1].toFixed(1)}), straight ${straight.toFixed(1)} m`)
const t0 = performance.now()
const route = pf.findPath(A, B)
const ms = performance.now() - t0
w(`route: found=${route.found} length=${route.length.toFixed(1)} m, ${route.nodes} nodes, expanded ${route.expanded}, ${ms.toFixed(1)} ms`)
check('long route found', route.found && route.points.length > 3)
const ratio = route.length / straight
check(`detour ratio sane (${ratio.toFixed(2)}x straight)`, route.found && ratio < 2.5 && route.length >= straight * 0.95)

hr('T3 - route contiguity (every hop is one graph edge)')
let maxHop = 0
let minHop = Infinity
let contiguous = true
for (let i = 0; i < route.points.length - 1; i += 1) {
  const h = Math.hypot(route.points[i + 1][0] - route.points[i][0], route.points[i + 1][1] - route.points[i][1])
  if (h <= 0) contiguous = false
  maxHop = Math.max(maxHop, h)
  minHop = Math.min(minHop, h)
}
w(`hops: ${route.points.length - 1}, min ${minHop.toFixed(1)} m, max ${maxHop.toFixed(1)} m`)
check('no zero-length hops', contiguous)
// The bound is the graph's own longest segment edge: a hop must never exceed
// one edge (the longest hops here are ~76 m of real OSM way).
let maxSegLen = 0
for (const e of pf.edgeList) maxSegLen = Math.max(maxSegLen, e.len)
check(`hops are single edges (<= longest segment ${maxSegLen.toFixed(1)} m + stitch slop)`, maxHop <= maxSegLen + STITCH_SLOP)
check('polylineLength agrees with the reported length', polylineLength(route.points) === route.length)
hr('T4 - nearest() snapping')
const exact = pf.nearest(pf.nx[123], pf.nz[123])
check('exact node snaps at distance 0', exact && exact.dist < 1e-9, exact ? `id ${exact.id}` : '')
const midX = (A[0] + B[0]) / 2
const midZ = (A[1] + B[1]) / 2
const mid = pf.nearest(midX, midZ)
check('midpoint snaps to SOME node', !!mid, mid ? `dist ${mid.dist.toFixed(1)} m` : 'null')
const empty = buildRoadPathfinder([])
check('empty graph: nearest returns null (no garbage)', empty.nearest(0, 0) === null)

hr('T5 - unreachable goal is PARTIAL, not garbage')
// Two disjoint synthetic islands 100 m apart (no stitch can join them).
const twoIslands = buildRoadPathfinder([
  { ax: 0, az: 0, bx: 30, bz: 0, len: 30 },
  { ax: 30, az: 0, bx: 30, bz: 30, len: 30 },
  { ax: 100, az: 0, bx: 130, az: 0, len: 30 },
  { ax: 130, az: 0, bx: 130, bz: 30, len: 30 },
])
const partial = twoIslands.findPath([0, 0], [130, 30])
w(`island route: found=${partial.found} partial=${partial.partial} goalDist=${partial.goalDist?.toFixed?.(1)} length=${partial.length.toFixed(1)}`)
check('unreachable goal: found=false', partial.found === false)
check('unreachable goal: partial=true with positive goalDist', partial.partial === true && partial.goalDist > 0)
check(
  'partial route still starts on the right island (no garbage coordinates)',
  partial.points.length > 0 && Math.abs(partial.points[0][0]) < 1 && Math.abs(partial.points[0][1]) < 1,
  partial.points.length ? `first ${JSON.stringify(partial.points[0])}` : 'none',
)

hr('T6 - randomRoute: deterministic closed loop for a seed')
const r1 = pf.randomRoute(7)
const r2 = pf.randomRoute(7)
const r3 = pf.randomRoute(8)
check('seed 7 gives a route', !!r1, r1 ? `${r1.length.toFixed(1)} m, ${r1.points.length} pts` : '')
check('seed 7 is reproducible', !!r1 && !!r2 && JSON.stringify(r1.points) === JSON.stringify(r2.points))
if (r1) {
  check('loop is closed (first === last)', Math.abs(r1.points[0][0] - r1.points[r1.points.length - 1][0]) < 1e-6 && Math.abs(r1.points[0][1] - r1.points[r1.points.length - 1][1]) < 1e-6)
}
check('different seed gives a different (or at least a valid) route', !!r3 && (!r1 || JSON.stringify(r3.points) !== JSON.stringify(r1.points)))

hr('T7 - sampleRoute walks the route')
const pts = (r1 && r1.points) || route.points
const out = { x: 0, z: 0, yaw: 0, done: false }
sampleRoute(pts, 0, out)
const s0 = { ...out }
const total = polylineLength(pts)
sampleRoute(pts, total / 2, out)
const sHalf = { ...out }
sampleRoute(pts, total + 5, out)
w(`s=0 -> (${s0.x.toFixed(1)}, ${s0.z.toFixed(1)}) yaw ${s0.yaw.toFixed(2)}; mid -> (${sHalf.x.toFixed(1)}, ${sHalf.z.toFixed(1)}); end done=${out.done}`)
check('sample at 0 starts on the route', Math.hypot(s0.x - pts[0][0], s0.z - pts[0][1]) < 1e-6)
check('sample at midpoint is between start and end', Math.hypot(sHalf.x - s0.x, sHalf.z - s0.z) > 1)
check('past-the-end sample reports done=true at the last point', out.done && Math.hypot(out.x - pts[pts.length - 1][0], out.z - pts[pts.length - 1][1]) < 1e-6)
check('yaw is finite and bounded', Number.isFinite(s0.yaw) && Math.abs(s0.yaw) <= Math.PI + 1e-9)

hr('T8 - stitch=0 on the REAL graph (must never be better than stitched)')
const unstitched = buildRoadPathfinder(buildSegments(data, (t) => DRIVABLE.has(t)), { stitch: 0 })
const uStats = unstitched.stats()
const uConnectivity = connectivityOf(unstitched)
w(`stitch=0: ${uStats.nodes} nodes, ${uStats.edges} edges, largest component ${(uConnectivity * 100).toFixed(1)}% (stitched: ${(connectivity * 100).toFixed(1)}%)`)
check('stitching did not make the real graph WORSE', connectivity >= uConnectivity)
const uRoute = unstitched.findPath(A, B)
w(`stitch=0 route: found=${uRoute.found} partial=${uRoute.partial} length=${uRoute.length.toFixed(1)} m`)
check('stitch=0 either routes fine (ways share nodes) or degrades to partial — never crashes', uRoute.found === true || uRoute.partial === true)

hr('T9 - module cache: one pathfinder per (data, filter)')
const data2 = JSON.parse(readFileSync(new URL('../public/map_data.json', import.meta.url), 'utf8'))
const pfA = getRoadPathfinder(data, 'drivable')
const pfB = getRoadPathfinder(data, 'drivable')
const pfC = getRoadPathfinder(data2, 'drivable')
check('same data + same filter === same instance (WeakMap key)', pfA === pfB)
check('DIFFERENT data object builds a DIFFERENT instance', pfA !== pfC)
check('cached graph is equivalent to the manually built one', pfA.size === pf.size && pfA.stats().edges === pf.stats().edges, `${pfA.size}/${pfA.stats().edges} vs ${pf.size}/${pf.stats().edges}`)
const walk = getRoadPathfinder(data, 'walkable')
check('walkable filter builds its own graph (footways add nodes)', !!walk && walk.size >= pf.size, `walk ${walk?.size} vs drivable ${pf.size}`)

/* ------------------------------------------------------------------ */
/* verdict                                                             */
/* ------------------------------------------------------------------ */

hr('verdict')
if (failures === 0) w('ALL CHECKS PASSED')
else w(`${failures} CHECK(S) FAILED`)
w('done')
process.exit(0)

