// Proof harness for the AI-traffic route PLANNER (src/lib/trafficRoutes.js).
//
//   cd workspace && node scripts/traffic-routes-repro.mjs
//
// Imports the PRODUCTION planner + pathfinder — not copies — and feeds them
// the REAL public/map_data.json, so it verifies exactly what the game runs:
//
//   T0  the real drivable graph builds and plugs into the planner
//   T1  planCoverageRoutes returns `count` valid CLOSED loops on real roads
//   T2  coverage-greedy picks cover >= the OLD naive seed recipe (same count)
//   T3  spawn starts are spread out across the city (min pairwise distance)
//   T4  planning is deterministic (same pf + count => identical routes)
//   T5  rerouteLoop returns closed loops anchored near the car, sane length
//   T6  the shared usage registry equals plan coverage, then GROWS as
//       reroutes register their edges (the unvisited-road bias is real)
//   T7  coverageOf stays consistent (empty = 0, planned <= 1.0)
//
// Always writes scripts/traffic-routes-repro.txt; exits 0 (the report is the
// artifact — same convention as roadpath-repro.mjs).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getRoadPathfinder, polylineLength } from '../src/lib/RoadPathfinder.js'
import { coverageOf, planCoverageRoutes, rerouteLoop, usageSize } from '../src/lib/trafficRoutes.js'
import { DRIVABLE, buildSegments } from '../src/lib/worldData.js'

const F = fileURLToPath(new URL('./traffic-routes-repro.txt', import.meta.url))
writeFileSync(F, '')
const w = (s) => appendFileSync(F, String(s) + '\r\n')
const hr = (s) => w(`\r\n--- ${s} ---`)
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  w(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/** Min pairwise distance between route start points. */
const minStartSpread = (routes) => {
  let best = Infinity
  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const d = Math.hypot(routes[i][0][0] - routes[j][0][0], routes[i][0][1] - routes[j][0][1])
      if (d < best) best = d
    }
  }
  return routes.length < 2 ? Infinity : best
}

const data = JSON.parse(readFileSync(fileURLToPath(new URL('../public/map_data.json', import.meta.url)), 'utf8'))
const pf = getRoadPathfinder(data, 'drivable')
const stats = pf.stats()
const COUNT = 16 // AI_CAR_COUNT in Npcs.jsx

hr('T0 - real graph into the planner')
w(`roads in data: ${(data.roads || []).length}, drivable segments: ${buildSegments(data, (t) => DRIVABLE.has(t)).length}`)
w(`graph: ${stats.nodes} nodes, ${stats.edges} edges (${stats.stitched} stitched)`)
check('graph is routable', pf.size > 100 && stats.edges > 100)
check('usage registry starts empty (fresh process)', usageSize(pf) === 0, `${usageSize(pf)} edges`)

hr('T1 - planCoverageRoutes: count valid closed loops')
const t0 = performance.now()
const planned = planCoverageRoutes(pf, COUNT)
const planMs = performance.now() - t0
check(`returns ${COUNT} routes`, planned.length === COUNT, `got ${planned.length} in ${planMs.toFixed(0)} ms`)
let allClosed = true
let allFinite = true
let totalPlanLen = 0
for (const r of planned) {
  if (!r || r.length < 3) { allClosed = false; continue }
  if (Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) > 1e-6) allClosed = false
  for (const p of r) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) allFinite = false
  }
  totalPlanLen += polylineLength(r)
}
check('every loop is CLOSED (first point === last)', allClosed)
check('every point is finite', allFinite)
w(`planned fleet: ${totalPlanLen.toFixed(0)} m of loops, avg ${(totalPlanLen / Math.max(1, planned.length)).toFixed(0)} m/car`)
// Snapshot BEFORE any reroute runs (T5) so T6 can prove growth from here.
const afterPlan = usageSize(pf)

hr('T2 - coverage vs the OLD naive seed recipe (same fleet size)')
const naive = []
for (let k = 0; k < COUNT; k += 1) {
  const r = pf.randomRoute(k * 977 + 13)
  if (r && r.points.length >= 3) naive.push(r.points)
}
const covP = coverageOf(pf, planned)
const covN = coverageOf(pf, naive)
w(`planned: ${covP.covered}/${covP.edges} edges = ${(covP.fraction * 100).toFixed(1)}%`)
w(`naive:   ${covN.covered}/${covN.edges} edges = ${(covN.fraction * 100).toFixed(1)}% (${naive.length} routes)`)
check('coverage-greedy >= naive same-count picks', covP.covered >= covN.covered,
  `${covP.covered} vs ${covN.covered}`)
check('fleet covers a meaningful share of the graph (>20%)', covP.fraction > 0.2,
  `${(covP.fraction * 100).toFixed(1)}%`)

hr('T3 - spawn spread across the city')
const spreadP = minStartSpread(planned)
const spreadN = minStartSpread(naive)
w(`min pairwise start distance — planned ${spreadP.toFixed(1)} m, naive ${spreadN.toFixed(1)} m`)
check('planned starts are not clumped (>= 15 m apart)', spreadP >= 15, `${spreadP.toFixed(1)} m`)

hr('T4 - determinism')
const planned2 = planCoverageRoutes(pf, COUNT)
check('same pf + count => identical routes', JSON.stringify(planned2) === JSON.stringify(planned))

hr('T5 - rerouteLoop: closed loops anchored at the car')
const K = 8
let okCount = 0
let closedCount = 0
let anchorOk = 0
let lenOk = 0
for (let t = 0; t < K; t += 1) {
  const ni = Math.floor((t + 0.5) * (pf.size / K)) % pf.size
  const x = pf.nx[ni]
  const z = pf.nz[ni]
  const loop = rerouteLoop(pf, x, z, { seed: 400 + t })
  if (!loop) {
    w(`  start ${t} (${x.toFixed(0)}, ${z.toFixed(0)}): NO LOOP`)
    continue
  }
  okCount += 1
  const first = loop[0]
  const last = loop[loop.length - 1]
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) closedCount += 1
  // Loop starts at the nearest junction: up to half a max-length (180 m) segment.
  const anchor = Math.hypot(first[0] - x, first[1] - z)
  if (anchor <= 95) anchorOk += 1
  const len = polylineLength(loop)
  if (len >= 60 && len <= 2500 && loop.length >= 4) lenOk += 1
  w(`  start ${t} (${x.toFixed(0)}, ${z.toFixed(0)}): ${loop.length} pts, ${len.toFixed(0)} m, anchor ${anchor.toFixed(1)} m`)
}
check(`reroutes found from >= ${K - 2}/${K} sampled positions`, okCount >= K - 2, `${okCount}/${K}`)
check('all reroute loops closed', closedCount === okCount, `${closedCount}/${okCount}`)
check('anchors within half-segment (<= 95 m)', anchorOk === okCount, `${anchorOk}/${okCount}`)
check('reroute lengths sane (60-2500 m, >= 4 pts)', lenOk === okCount, `${lenOk}/${okCount}`)

hr('T6 - usage registry grows (unvisited-road bias is real)')
check('registry equals plan coverage right after planning', afterPlan === covP.covered,
  `${afterPlan} vs ${covP.covered}`)
const afterReroutes = usageSize(pf)
check('reroutes registered additional unseen edges', afterReroutes > afterPlan + 4,
  `${afterPlan} -> ${afterReroutes}`)

hr('T7 - coverageOf sanity')
const empty = coverageOf(pf, [])
check('empty fleet covers nothing', empty.covered === 0 && empty.fraction === 0)
check('planned fraction <= 1.0', covP.fraction <= 1.0, `${covP.fraction.toFixed(3)}`)

hr('verdict')
if (failures === 0) w('ALL CHECKS PASSED')
else w(`${failures} CHECK(S) FAILED`)
w('done')
process.exit(0)

