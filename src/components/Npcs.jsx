// Pedestrians + AI traffic. Peds are kinematic capsules; HP lives on the
// MODULE record (NPC_RECORDS) - WeaponController hits set dead, render does
// fall + drops via spawnDrop(). Traffic loops the road graph.
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Line } from '@react-three/drei'
import { RigidBody, CapsuleCollider, CuboidCollider } from '@react-three/rapier'
import {
  buildingPolygons,
  buildRoadGraph,
  buildSegments,
  DRIVABLE,
  hash01,
  loadWorldData,
  pointInPolygon,
  roadPolyline,
  WALKABLE,
} from '../lib/worldData'
import useGameStore, { Phase } from '../store/useGameStore'
import { NPC_HP } from '../lib/weapons'
import { getRoadPathfinder, sampleRoute, polylineLength } from '../lib/RoadPathfinder'
import { coverageOf, planCoverageRoutes, rerouteLoop } from '../lib/trafficRoutes'
import { navPath, navRandomPointAround } from '../lib/navmesh'
import { navRuntime } from './CityNavMesh'
import { spawnDrop } from './Pickups'
import {
  AI_CAR_BODIES,
  AI_CAR_DAMAGE,
  AI_CAR_LIVE,
  HALF,
  CarDriver,
  CarModel,
  crash,
  crashHitFromPayload,
  addAiDamage,
  getCarBody,
  isAiCarOccupied,
  isOnAsphalt,
  setAiCarOccupied,
  setAiLive,
} from './Car'
import { combat } from '../lib/combat'
import { audio } from '../lib/audio'
import { setAnimAi } from './car-modules/carVisuals.js'
import { CarWheels } from './car-modules/CarWheels.jsx'
import Protagonist, { CHARACTERS } from './Protagonist'

export const PED_COUNT = 10
export const PED_RADIUS = 200
// 16 (was 5/8): coverage-greedy route planning + per-lap re-routing (see
// lib/trafficRoutes.js + buildAiRoutes/tryReroute below) make extra cars
// cheap — they spread over the whole road graph instead of stacking on a few
// circuits. Each is one dynamic body + KayKit model; expect ~+8 Rapier bodies
// vs the old 8-car fleet in the smoke report, fps should hold.
export const AI_CAR_COUNT = 16
export const AI_CAR_RADIUS = 280
export const NPC_KILL_TOAST = 'Ped down - cash dropped'
export const NPC_RECORDS = []
export const AI_CAR_STATE = []
// Module-level storage for AI routes (for debug visualization)
export const AI_ROUTES = []
// Live pathfinder for AiCar per-lap re-routing (set by buildAiRoutes; stays
// null only when routing itself failed and the legacy walker took over).
let aiPathfinder = null
for (let i = 0; i < PED_COUNT; i += 1) {
  NPC_RECORDS.push({ i, kind: 'ped', hp: NPC_HP, dead: false, deadAt: 0, killer: null, rb: null })
}

// QA seam (scripts/smoke.mjs): read pedestrian state without touching the
// render tree. Mirrors window.__gtathensCars (Car.jsx) — a stable object whose
// methods return plain numbers, so the headless test can assert that a real
// fired shot actually damaged a ped and that a kill dropped loot.
export const npcsQA = {
  count: () => NPC_RECORDS.length,
  ped: (i) => {
    const r = NPC_RECORDS[i]
    if (!r) return null
    let x = 0
    let y = 0
    let z = 0
    if (r.rb && typeof r.rb.translation === 'function') {
      try {
        const t = r.rb.translation()
        x = t.x
        y = t.y
        z = t.z
      } catch (e) { /* noop */ }
    }
    return { x, y, z, hp: r.hp, dead: !!r.dead }
  },
  aliveCount: () => NPC_RECORDS.reduce((n, r) => n + (r.dead ? 0 : 1), 0),
  /** Index of the living ped nearest to (x, z), or -1. */
  nearest: (x, z) => {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < NPC_RECORDS.length; i += 1) {
      const r = NPC_RECORDS[i]
      if (!r || r.dead || !r.rb || typeof r.rb.translation !== 'function') continue
      let t = null
      try {
        t = r.rb.translation()
      } catch (e) {
        t = null
      }
      if (!t) continue
      const d = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  },
  /**
   * Live AI-traffic census for scripts/smoke.mjs (TRAFFIC TEST): plain
   * {i, x, z, speed} per mounted traffic car, read from the crash singleton's
   * aiLive records (mutated per frame by AiCar — no React involved).
   */
  traffic: () => {
    const out = []
    for (let i = 0; i < AI_CAR_STATE.length; i += 1) {
      const l = crash.aiLive[i]
      if (!l || !Number.isFinite(l.x)) continue
      out.push({ i, x: l.x, z: l.z, speed: Number.isFinite(l.speed) ? l.speed : 0 })
    }
    return out
  },
  /** Fleet route stats: loops, total metres, distinct-road coverage 0..1. */
  routeStats: () => {
    if (AI_ROUTES.length === 0) return null
    let total = 0
    for (let i = 0; i < AI_ROUTES.length; i += 1) total += polylineLength(AI_ROUTES[i])
    const cov = aiPathfinder ? coverageOf(aiPathfinder, AI_ROUTES) : null
    return {
      routes: AI_ROUTES.length,
      totalM: Math.round(total),
      edges: cov ? cov.edges : 0,
      covered: cov ? cov.covered : 0,
      coverage: cov ? Number(cov.fraction.toFixed(3)) : null,
    }
  },
}
if (typeof window !== 'undefined') window.__gtathensNpcs = npcsQA

const PED_SPEED = 1.5
const AI_CRUISE = 10
const GROUP_GROUND = 0x0001
const GROUP_PLAYER = 0x0002
const GROUP_CAR = 0x0004
const GROUP_BUILDING = 0x0008
// Peds accept everything (they must collide with cars AND be hittable).
const PED_GROUPS = GROUP_PLAYER | ((GROUP_GROUND | GROUP_PLAYER | GROUP_CAR | GROUP_BUILDING) << 16)
// AI traffic accepts everything INCLUDING other cars: Rapier only runs the
// solver + collision events when EACH side's filter accepts the other, so an
// AI body that filtered out GROUP_CAR would ghost straight through parked
// cars and its siblings (the reported "npc cars do not collide" bug).
const AI_CAR_GROUPS = GROUP_CAR | ((GROUP_GROUND | GROUP_PLAYER | GROUP_CAR | GROUP_BUILDING) << 16)

const buildPedSpawns = (data, spawn, count) => {
  const segs = []
  for (const road of data.roads || []) {
    if (!WALKABLE.has(road.type)) continue
    const pts = roadPolyline(road)
    for (let i = 0; i < pts.length - 1; i += 1) {
      const ax = pts[i][0]
      const az = pts[i][1]
      const bx = pts[i + 1][0]
      const bz = pts[i + 1][1]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 10 || len > 170) continue
      const mx = (ax + bx) / 2
      const mz = (az + bz) / 2
      if (Math.hypot(mx - spawn[0], mz - spawn[1]) > PED_RADIUS) continue
      segs.push([ax, az, bx, bz, len])
    }
  }
  if (segs.length === 0) {
    const drive = buildSegments(data, (t) => DRIVABLE.has(t))
    for (const s of drive) {
      const mx = (s.ax + s.bx) / 2
      const mz = (s.az + s.bz) / 2
      if (Math.hypot(mx - spawn[0], mz - spawn[1]) > PED_RADIUS) continue
      segs.push([s.ax, s.az, s.bx, s.bz, s.len])
    }
  }
  const polys = buildingPolygons(data)
  const out = []
  for (let k = 0; k < count; k += 1) {
    let placed = false
    for (let attempt = 0; attempt < 24 && !placed; attempt += 1) {
      if (segs.length === 0) break
      const seg = segs[Math.floor(hash01(k * 91 + attempt * 17) * segs.length) % segs.length]
      if (!seg) break
      const t = 0.1 + hash01(k * 13 + attempt * 7) * 0.8
      const px = seg[0] + (seg[2] - seg[0]) * t
      const pz = seg[1] + (seg[3] - seg[1]) * t
      if (Math.hypot(px - spawn[0], pz - spawn[1]) < 12) continue
      const side = hash01(k * 5 + attempt) > 0.5 ? 1 : -1
      const len = seg[4] || 1
      const x = px + ((seg[3] - seg[1]) / len) * 2.2 * side
      const z = pz + (-(seg[2] - seg[0]) / len) * 2.2 * side
      let inside = false
      for (const poly of polys) {
        if (pointInPolygon(x, z, poly)) { inside = true; break }
      }
      if (inside) continue
      out.push({ x, z })
      placed = true
    }
    if (!placed) out.push({ x: spawn[0] + 14 + k * 3, z: spawn[1] + 10 })
  }
  return out
}

const buildAiRoutes = (data, spawn, count) => {
  // FLEET planning via lib/trafficRoutes.js on the ROAD GRAPH (the same
  // graph GPS/minimap will use): build a pool of A* loops (randomRoute with
  // mixed short/long profiles), then GREEDILY pick `count` of them to
  // maximise distinct-road coverage + spawn-point spread — so traffic shows
  // up all over the city instead of stacking on a few favourite circuits.
  // The picked edges register into the planner's usage set, which later
  // biases each car's per-lap re-route (tryReroute in AiCar) onto roads the
  // fleet has not driven yet.
  // Fallback: legacy straight-preference random walk if routing can't
  // produce a single loop (e.g. a stub map with no connected junctions).
  let pf = null
  try {
    pf = getRoadPathfinder(data, 'drivable')
  } catch (e) {
    pf = null
  }
  aiPathfinder = pf
  if (pf && pf.size > 4) {
    let routes = []
    try {
      routes = planCoverageRoutes(pf, count)
    } catch (e) {
      routes = []
    }
    if (routes.length > 0) {
      // Store routes for debug visualization ('T' overlay)
      AI_ROUTES.length = 0
      for (const r of routes) AI_ROUTES.push(r)
      return routes
    }
  }
  return buildAiRoutesLegacy(data, spawn, count)
}

const buildAiRoutesLegacy = (data, spawn, count) => {
  // Loop routes from the road GRAPH (not isolated segments): random-walk from
  // a start junction, preferring to keep going straight (no U-turn ping-pong),
  // then close the loop back to the start. Result: a clean circuit the car
  // can lap forever without reversing.
  const segs = buildSegments(data, (t) => DRIVABLE.has(t))
  const near = segs.filter((s) => {
    const mx = (s.ax + s.bx) / 2
    const mz = (s.az + s.bz) / 2
    const d = Math.hypot(mx - spawn[0], mz - spawn[1])
    return d > 15 && d < AI_CAR_RADIUS
  })
  if (near.length === 0) return []
  const graph = buildRoadGraph(near)
  const nodeList = Array.from(graph.nodes.values())
  const starts = nodeList.filter((n) => {
    const d = Math.hypot(n.x - spawn[0], n.z - spawn[1])
    return d > 15 && d < AI_CAR_RADIUS
  })
  if (starts.length === 0) return []
  const routes = []
  for (let k = 0; k < count; k += 1) {
    const start = starts[Math.floor(hash01(k * 131 + 7) * starts.length) % starts.length]
    // Random walk with straight-through preference.
    const pts = [[start.x, start.z]]
    let prev = null
    let node = start
    let prevDir = null
    for (let step = 0; step < 10; step += 1) {
      if (!node.adj || node.adj.length === 0) break
      // Exclude the node we came from (no instant U-turn) unless dead-end.
      let options = node.adj.filter((e) => e.to !== prev)
      if (options.length === 0) options = node.adj.slice()
      let next = options[0].to
      if (prevDir && options.length > 1) {
        // Pick the edge most aligned with travel direction (keeps the car
        // flowing through junctions instead of zig-zagging).
        let bestScore = -Infinity
        for (const e of options) {
          const dx = e.to.x - node.x
          const dz = e.to.z - node.z
          const len = Math.hypot(dx, dz) || 1
          const score = (dx / len) * prevDir[0] + (dz / len) * prevDir[1]
            + hash01(k * 977 + step * 61 + e.to.x) * 0.35
          if (score > bestScore) {
            bestScore = score
            next = e.to
          }
        }
      } else {
        const pick = Math.floor(hash01(k * 977 + step * 61) * options.length) % options.length
        next = options[pick].to
      }
      const dx = next.x - node.x
      const dz = next.z - node.z
      const len = Math.hypot(dx, dz) || 1
      prevDir = [dx / len, dz / len]
      prev = node
      node = next
      pts.push([node.x, node.z])
      // Loop closed: back near the start with a decent-length circuit.
      if (pts.length > 4 && Math.hypot(node.x - start.x, node.z - start.z) < 12) break
    }
    if (pts.length < 2) continue
    // Close the loop explicitly so the car laps seamlessly (last->first leg
    // is a real drive, not a teleport or a reverse).
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) > 1) pts.push([first[0], first[1]])
    routes.push(pts)
  }
  return routes
}

// AI traffic helper functions for path following and collision avoidance

/**
 * Finds the nearest point on a route polyline to a given position.
 * Returns { point: [x,z], dist, t } where t is the arc-length parameter.
 */
const findNearestOnRoute = (route, x, z) => {
  if (!route || route.length < 2) return null
  const totalLen = polylineLength(route)
  if (totalLen < 0.001) return null

  let bestDist = Infinity
  let bestT = 0
  let bestPoint = route[0]

  // Sample at intervals for efficiency
  const steps = Math.min(route.length * 2, 40)
  for (let i = 0; i <= steps; i += 1) {
    const s = (i / steps) * totalLen
    const out = { x: 0, z: 0, yaw: 0, done: false }
    sampleRoute(route, s, out)
    const dx = out.x - x
    const dz = out.z - z
    const d = dx * dx + dz * dz
    if (d < bestDist) {
      bestDist = d
      bestT = s
      bestPoint = [out.x, out.z]
    }
  }

  return {
    point: bestPoint,
    dist: Math.sqrt(bestDist),
    t: bestT,
    totalLen,
  }
}

/**
 * Gets a look-ahead target point on the route for smoother steering.
 * Instead of targeting the current position, we look ahead to anticipate turns.
 * The target is pushed into the RIGHT-HAND LANE (traffic keeps right of the
 * centerline the way the OSM ways are drawn).
 */
const LANE_OFFSET = 1.1

const getLookAheadTarget = (route, progress, lookAheadDist, totalLen) => {
  const span = totalLen > 0 ? totalLen : polylineLength(route)
  // Closed loops wrap: progress + look-ahead past the seam continues at s=0.
  // The old Math.min() clamped at the seam, so the target froze at the last
  // point for ~10 m and the car swerved on every lap reset.
  let targetS = progress + lookAheadDist
  if (span > 1e-6) {
    targetS %= span
    if (targetS < 0) targetS += span
  } else {
    targetS = Math.min(targetS, span)
  }
  const dist = span > 1e-6 ? lookAheadDist : Math.min(lookAheadDist, span - progress)
  const out = { x: 0, z: 0, yaw: 0, done: false }
  sampleRoute(route, targetS, out)
  // Right of travel = (cos yaw, -sin yaw).
  out.x += Math.cos(out.yaw) * LANE_OFFSET
  out.z -= Math.sin(out.yaw) * LANE_OFFSET
  return {
    x: out.x,
    z: out.z,
    yaw: out.yaw,
    dist,
  }
}

/**
 * PROJECT the car's actual XZ onto the route near a guessed arc-length
 * (`sGuess`, searched within ±PROJ_WINDOW metres). Returns the corrected arc
 * length. This replaces dead-reckoned progress (`progress += speed*dt`), which
 * desyncs from reality after any bump or avoidance push — then the look-ahead
 * target pointed somewhere else entirely and cars wandered off the road.
 */
const PROJ_WINDOW = 14
const PROJ_STEP = 2
const projectOnRoute = (route, x, z, sGuess, totalLenHint = 0) => {
  if (!route || route.length < 2) return sGuess
  let bestS = sGuess
  let bestD = Infinity
  let acc = 0
  const lo = sGuess - PROJ_WINDOW
  const hi = sGuess + PROJ_WINDOW
  // Closed-loop wrap: a car just past the seam (sGuess ~ totalLen) projects
  // near s=0 and vice versa. Without this the window misses and the
  // look-ahead target jumps to the stale guess — the "lap-reset swerve".
  const totalLen = totalLenHint > 0 ? totalLenHint : polylineLength(route)
  for (let i = 0; i < route.length - 1; i += 1) {
    const ax = route[i][0]
    const az = route[i][1]
    const dx = route[i + 1][0] - ax
    const dz = route[i + 1][1] - az
    const segLen = Math.hypot(dx, dz)
    if (segLen < 1e-6) continue
    // Seam-aware overlap: test the segment at its raw span AND at ±totalLen
    // aliases; the first alias overlapping [lo, hi] is the one we sample.
    // (A car just past the loop seam has sGuess ~ totalLen while the same
    // asphalt lives near s=0 — a raw-span test misses it entirely.)
    let sLo = -1
    let sHi = -1
    let shift = 0
    const shifts = totalLen > 1e-6 ? [0, totalLen, -totalLen] : [0]
    for (let sh = 0; sh < shifts.length && sLo < 0; sh += 1) {
      const a = acc + shifts[sh]
      const b = acc + segLen + shifts[sh]
      const oLo = Math.max(a, lo)
      const oHi = Math.min(b, hi)
      if (oLo < oHi) { sLo = oLo - shifts[sh]; sHi = oHi - shifts[sh]; shift = shifts[sh] }
    }
    if (sLo < sHi) {
      const steps = Math.max(1, Math.ceil((sHi - sLo) / PROJ_STEP))
      for (let k = 0; k <= steps; k += 1) {
        const s = sLo + (sHi - sLo) * (k / steps)
        const f = (s - acc) / segLen
        const px = ax + dx * f
        const pz = az + dz * f
        const d = (px - x) * (px - x) + (pz - z) * (pz - z)
        if (d < bestD) { bestD = d; bestS = s + shift }
      }
    }
    acc += segLen
  }
  if (bestD >= Infinity) return sGuess
  // Normalise back into [0, totalLen) so the wrap check below fires exactly once.
  if (totalLen > 1e-6) {
    let n = bestS % totalLen
    if (n < 0) n += totalLen
    return n
  }
  return bestS
}

/**
 * Computes avoidance steering to avoid collision with other cars.
 */
const computeAvoidSteer = (x, z, yaw, speed, others, index, route) => {
  let avoidX = 0
  let avoidZ = 0
  let imminentCollision = false

  for (let k = 0; k < others.length; k += 1) {
    if (k === index) continue
    const o = others[k]
    if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z)) continue

    const odx = o.x - x
    const odz = o.z - z
    const od = Math.hypot(odx, odz)

    // Check if other car is in front
    const cosY = Math.cos(-yaw)
    const sinY = Math.sin(-yaw)
    const localX = odx * cosY - odz * sinY
    const localZ = odx * sinY + odz * cosY

    // Car in front and too close
    if (localZ < AI_AVOID_DIST && localZ > -4 && Math.abs(localX) < 4) {
      const urgency = Math.max(0, 1 - od / AI_AVOID_DIST)
      const side = localX > 0 ? -1 : 1

      // Check if we can steer that way
      const testAngle = side * 0.5
      const testX = x + Math.sin(yaw + testAngle) * 6
      const testZ = z + Math.cos(yaw + testAngle) * 6

      let canSteer = true
      for (let j = 0; j < others.length; j += 1) {
        if (j === index || j === k) continue
        const oo = others[j]
        if (!oo || !Number.isFinite(oo.x)) continue
        if (Math.hypot(testX - oo.x, testZ - oo.z) < AI_AVOID_DIST * 0.6) {
          canSteer = false
          break
        }
      }

      if (canSteer) {
        avoidX += side * urgency * 0.35
        avoidZ += urgency * 0.15
        imminentCollision = true
      } else {
        // Can't steer, strong brake
        avoidZ -= urgency * 0.3
      }
      break
    }

    // Check if other car is heading towards us (head-on or merging)
    if (od < AI_AVOID_DIST * 2) {
      // Own urgency for THIS branch (window = 2x AI_AVOID_DIST): the inner
      // steering below used to reference the `urgency` const scoped inside
      // the sibling "car in front" branch — a TDZ ReferenceError the moment
      // this branch actually ran (two cars in-line 7-14 m apart with a third
      // beside one of them), which escaped useFrame and froze that frame's
      // traffic. It would also have been 0 out here anyway (window mismatch).
      const urgency = Math.max(0, 1 - od / (AI_AVOID_DIST * 2))
      const otherYaw = o.yaw || 0
      const odx2 = x - o.x
      const odz2 = z - o.z
      const oLocalX = odx2 * Math.cos(-otherYaw) - odz2 * Math.sin(-otherYaw)
      const oLocalZ = odx2 * Math.sin(-otherYaw) + odz2 * Math.cos(-otherYaw)

      if (oLocalZ < 2 && Math.abs(oLocalX) < 3) {
        // Other car is heading towards us
        const relSpeed = Math.abs(speed + (o.speed || 0)) * 0.5
        if (relSpeed > 1.5) {
          // Determine which side has more room
          const leftClear = !isDirectionBlocked(x, z, yaw, -1, others, index, AI_AVOID_DIST * 0.8)
          const rightClear = !isDirectionBlocked(x, z, yaw, 1, others, index, AI_AVOID_DIST * 0.8)
          
          if (leftClear && !rightClear) {
            avoidX -= urgency * 0.2
          } else if (rightClear && !leftClear) {
            avoidX += urgency * 0.2
          } else if (!leftClear && !rightClear) {
            // Both sides blocked, brake hard
            avoidZ -= urgency * 0.4
          }
        }
      }
    }
  }

  return [avoidX, avoidZ, imminentCollision]
}

/**
 * Checks if a direction is blocked by other cars.
 */
const isDirectionBlocked = (x, z, yaw, side, others, index, checkDist) => {
  const testX = x + Math.sin(yaw + side * 0.4) * checkDist
  const testZ = z + Math.cos(yaw + side * 0.4) * checkDist
  
  for (let j = 0; j < others.length; j += 1) {
    if (j === index) continue
    const o = others[j]
    if (!o || !Number.isFinite(o.x)) continue
    if (Math.hypot(testX - o.x, testZ - o.z) < 2.5) {
      return true
    }
  }
  return false
}

const setKb = (rb, x, y, z) => {
  try {
    rb.setNextKinematicTranslation({ x, y, z })
  } catch (e) {
    try { rb.setTranslation({ x, y, z }, true) } catch (e2) { /* noop */ }
  }
}

const Ped = ({ index, x, z, dir }) => {
  const bodyRef = useRef(null)
  const gRef = useRef(null)
  const rec = NPC_RECORDS[index]
  const [action, setAction] = useState('idle')
  const st = useRef({ px: x, pz: z, yaw: dir, deadNotified: false, wob: Math.random() * 9 })
  const s = st.current

  useEffect(() => {
    if (rec) rec.rb = bodyRef.current
    return () => { if (rec && rec.rb === bodyRef.current) rec.rb = null }
  }, [rec])

  useEffect(() => {
    if (rec && !rec.dead) {
      s.px = x
      s.pz = z
      s.yaw = dir
      s.deadNotified = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, z])

  useFrame((state, dtRaw) => {
    const rb = bodyRef.current
    if (!rb || !rec) return
    const dt = Math.min(dtRaw, 0.05)
    const gs = useGameStore.getState()
    if (rec.dead) {
      try {
        const t = rb.translation()
        setKb(rb, t.x, Math.max(0, t.y - dt * 1.6), t.z)
      } catch (e) { /* noop */ }
      if (!s.deadNotified) {
        s.deadNotified = true
        try {
          const t = rb.translation()
          spawnDrop('money', t.x, t.z, 8 + Math.floor(Math.random() * 30))
          spawnDrop('ammo', t.x + 0.5, t.z + 0.4, 12 + Math.floor(Math.random() * 24))
        } catch (e) { /* noop */ }
        if (gs.pushToast) gs.pushToast(NPC_KILL_TOAST, 'info')
        setAction('idle')
      }
      return
    }
    if (gs.phase !== Phase.PLAYING) return
    s.wob += dt
    const wob = Math.sin(s.wob * 0.9) * 0.35
    // --- navmesh-guided wander (CityNavMesh; blind fallback when unready) ---
    // A ped walks a string-pulled path to a nearby random walkable point, then
    // picks another. All per-frame work reuses scalars; allocation only happens
    // on the rare repick (navPath returns a fresh array — that's fine, it is
    // not per frame).
    let heading
    if (navRuntime.ready && navRuntime.query) {
      if (!s.navPath && (s.navAt == null || s.wob - s.navAt > 1.5)) {
        s.navAt = s.wob
        const t = navRandomPointAround(navRuntime.query, s.px, s.pz, 22, (index * 8191 + Math.floor(s.wob * 7)) | 0)
        if (t) {
          const p = navPath(navRuntime.query, [s.px, s.pz], [t.x, t.z])
          if (p.found && p.points.length > 1) {
            s.navPath = p.points
            s.navI = 1
          }
        }
      }
      const wp = s.navPath ? s.navPath[s.navI] : null
      if (wp) {
        const wx = wp[0] - s.px
        const wz = wp[1] - s.pz
        if (Math.hypot(wx, wz) < 1.0) {
          s.navI += 1
          if (s.navI >= s.navPath.length) {
            s.navPath = null
            s.navAt = s.wob - 1.4 // repick on a later frame, never same-frame
          }
        } else {
          heading = Math.atan2(wx, wz) + wob * 0.3
        }
      }
      if (s.navPath && s.wob - (s.navAt || 0) > 12) s.navPath = null // stale route
    }
    if (heading === undefined) heading = s.yaw + wob
    s.yaw = heading
    let nx = s.px + Math.sin(heading) * PED_SPEED * dt
    let nz = s.pz + Math.cos(heading) * PED_SPEED * dt
    try {
      const t = rb.translation()
      const pushed = Math.hypot(t.x - s.px, t.z - s.pz)
      if (pushed > 0.08 && pushed < 6) {
        nx = t.x + Math.sin(s.yaw) * PED_SPEED * dt
        nz = t.z + Math.cos(s.yaw) * PED_SPEED * dt
        if (Math.abs(pushed - PED_SPEED * dt) > 0.02) s.yaw += dt * 1.0
      }
    } catch (e) { /* noop */ }
    if (!s.navPath && Math.random() < dt * 0.03) s.yaw += (Math.random() - 0.5) * 1.2
    s.px = nx
    s.pz = nz
    try {
      const t = rb.translation()
      const y = Number.isFinite(t.y) ? Math.max(0, Math.min(3, t.y)) : 0
      setKb(rb, nx, y, nz)
    } catch (e) { /* noop */ }
    if (action !== 'run') setAction('run')
    if (gRef.current) {
      gRef.current.position.set(nx, 0, nz)
      // Model faces +Z already (same convention as the player: yaw =
      // atan2(vx, vz)). No extra PI — the old `+ Math.PI` turned every ped
      // around so they moonwalked backwards along their walk direction.
      gRef.current.rotation.set(0, s.yaw, 0)
    }
  })

  return (
    <group ref={gRef} position={[x, 0, z]} rotation={[0, dir, 0]}>
      <RigidBody
        ref={bodyRef}
        type="kinematicPosition"
        colliders={false}
        position={[0, 0.95, 0]}
        collisionGroups={PED_GROUPS}
      >
        <CapsuleCollider args={[0.6, 0.35]} />
      </RigidBody>
      {/* Fixed skin per ped (deterministic by index): with per-instance cloned
          materials (Protagonist.jsx) this never follows the player's skin. */}
      <Protagonist
        action={rec && rec.dead ? 'idle' : action}
        animSpeed={1}
        skin={(CHARACTERS[(index + 1) % CHARACTERS.length] || {}).skin || null}
      />
    </group>
  )
}

const CAR_COLORS = ['#c0392b', '#2980b9', '#7f8c8d', '#f39c12', '#27ae60', '#8e44ad', '#1abc9c', '#e67e22']

// AI traffic configuration - tuning constants (AI_CRUISE is defined above)
const AI_ACCEL_TAU = 2.5
const AI_AVOID_DIST = 7
const AI_RECOVER_DIST = 6
const MAX_STEER_ANGLE = 0.15
const AI_LOOK_AHEAD_DIST = 10
// Lateral-accel cap for cornering (m/s^2): v <= sqrt(AI_A_LAT * radius),
// radius derived from the heading change across the look-ahead span — cars
// ease off into turns instead of taking every junction at flat cruise.
const AI_A_LAT = 4.0
// Stuck detector: still-but-should-move this long (s) => reverse 1.1 s.
const AI_STUCK_SECS = 2.5
const AI_REVERSE_SECS = 1.1

// Road awareness: how far off road before we strongly correct
const OFF_ROAD_PENALTY_DIST = 4
const OFF_ROAD_SPEED_PENALTY = 0.4  // Speed multiplier when off road

const AiCar = ({ route, seed, index = 0 }) => {
  const bodyRef = useRef(null)
  const gRef = useRef(null)
  // State: progress along route as arc-length, position, yaw, speed.
  // `route` starts as the SPAWN loop prop but lives here: every lap the car
  // re-plans it (tryReroute below), so all per-frame reads go through
  // s.current.route — the prop is only the initial circuit.
  const s = useRef({
    progress: 0,
    x: route[0][0],
    z: route[0][1],
    yaw: 0,
    speed: 0,
    route,
    lap: 0,
    totalLen: polylineLength(route),
    wobble: Math.random() * 100,
    stuckT: 0,
    reverseT: 0,
  })

  // Initialize AI live state
  if (!crash.aiLive[index] || !Number.isFinite(crash.aiLive[index].x)) {
    crash.setAiLive(index, s.current.x, s.current.z)
  }

  // Per-lap re-route: when the car closes a loop, A* a NEW circuit from
  // where it IS now — scored by unvisited roads (trafficRoutes registry) —
  // so the fleet keeps covering the city instead of forever repeating the
  // spawn loop. Failure (graph island, no sane goal) keeps the old loop.
  const tryReroute = (x, z) => {
    const pf = aiPathfinder
    if (!pf || pf.size < 4) return false
    let next = null
    try {
      next = rerouteLoop(pf, x, z, { seed: index * 7919 + s.current.lap * 131 + 17 })
    } catch (e) {
      next = null
    }
    if (!next || next.length < 3) return false
    s.current.route = next
    s.current.totalLen = polylineLength(next)
    // Full-scan re-projection: the new loop starts at the NEAREST JUNCTION,
    // which can be up to half a long OSM segment away — the per-frame
    // ±14 m windowed projection would never find the car from there.
    const near = findNearestOnRoute(next, x, z)
    s.current.progress = near ? near.t : 0
    try { AI_ROUTES[index] = next } catch { /* debug overlay only */ }
    return true
  }

  // Full car roster for AI traffic
  const AI_CAR_IDS = [
    'sedan', 'sedan-blue', 'sedan-darkred',
    'sports', 'sports-yellow', 'sports-stripe',
    'muscle', 'muscle-black', 'muscle-green', 'muscle-teal',
    'suv', 'suv-black', 'suv-green', 'suv-teal',
    'suv-yellow', 'suv-blue', 'suv-orange', 'suv-red',
  ]
  const carId = AI_CAR_IDS[Math.abs(seed) % AI_CAR_IDS.length] || 'sedan'
  const half = HALF[carId] || HALF.sedan
  // Cruise speed variety (base 10 m/s ≈ 36 km/h). The old `(seed % 100)/250`
  // gave seeds 0..15 (one per car!) near-identical multipliers 0.90-0.96 —
  // this mixes 0.85-1.24 across the fleet instead.
  const cruiseMult = 0.85 + ((Math.abs(seed) * 37) % 40) / 100
  const carCruise = AI_CRUISE * cruiseMult

  const onHit = React.useCallback((p) => crashHitFromPayload(p, null, false, 0, index), [index])
  const onForce = React.useCallback((p) => crashHitFromPayload(p, null, true, p?.totalForceMagnitude ?? 0, index), [index])

  useFrame((state, dtRaw) => {
    const rb = bodyRef.current
    if (!rb || typeof rb.translation !== 'function') return
    // Register the body once so bullet -> car damage can resolve traffic cars
    // exactly (crash.bodyToSpot covers parked cars; aiBodies covers these).
    if (crash.aiBodies[index] !== rb) crash.aiBodies[index] = rb
    const dt = Math.min(dtRaw, 0.05)
    const gs = useGameStore.getState()
    if (gs.phase !== Phase.PLAYING) {
      try { rb.setLinvel({ x: 0, y: 0, z: 0 }, true) } catch (e) { /* noop */ }
      return
    }
    // Exploded (damage 100%): the fleet stops — burning wreck, no more
    // routing. FX already fired from addAiDamage's threshold crossing.
    if (crash.explodedAi.has(index)) {
      try { rb.setLinvel({ x: 0, y: 0, z: 0 }, true) } catch (e) { /* noop */ }
      try { setAnimAi(index, 0, 0, false) } catch (e) { /* noop */ }
      return
    }
    // A stolen AI car is driven by CarDriver (drivingAi flow) — never fight
    // it for the body. (isAiCarOccupied is already imported; the enter path
    // is half-built, so this is a cheap future-proofing guard, not a live
    // branch today.)
    try {
      if (isAiCarOccupied(index)) return
    } catch { /* noop */ }
    // The fleet re-plans this car's loop every lap (tryReroute) — the
    // `route` prop is only the SPAWN circuit; everything below reads the
    // live ref.
    const route = s.current.route

    // Get current position from physics
    const tPos = rb.translation()
    const currentX = tPos.x
    const currentZ = tPos.z

    // Update state
    s.current.x = currentX
    s.current.z = currentZ

    // Sample the route at current progress to get current position and heading
    const currentRouteOut = { x: 0, z: 0, yaw: 0, done: false }
    sampleRoute(route, s.current.progress, currentRouteOut)

    // If route is complete (shouldn't happen for closed loops, but safety)
    if (currentRouteOut.done) {
      s.current.progress = 0
      sampleRoute(route, 0, currentRouteOut)
    }

    // Get look-ahead target for smoother steering
    const lookAhead = getLookAheadTarget(
      route, 
      s.current.progress, 
      AI_LOOK_AHEAD_DIST + s.current.speed * 0.3,
      s.current.totalLen
    )

    // Direction to look-ahead target
    let dx = lookAhead.x - currentX
    let dz = lookAhead.z - currentZ
    let distToTarget = Math.hypot(dx, dz)

    // Calculate desired yaw from look-ahead point
    const desiredYaw = Math.atan2(dx, dz)

    // Off-course recovery: if far from route, steer towards nearest route point
    let recoverAngle = 0
    let isOffCourse = false
    const distToRoute = Math.hypot(
      currentX - currentRouteOut.x, 
      currentZ - currentRouteOut.z
    )

    if (distToRoute > AI_RECOVER_DIST * 0.5) {
      isOffCourse = true
      const nearest = findNearestOnRoute(route, currentX, currentZ)
      if (nearest && nearest.dist > 0.5) {
        const ndx = nearest.point[0] - currentX
        const ndz = nearest.point[1] - currentZ
        const nDist = Math.hypot(ndx, ndz)
        if (nDist > 0.1) {
          const recoverYaw = Math.atan2(ndx, ndz)
          let yawDiff = recoverYaw - s.current.yaw
          while (yawDiff > Math.PI) yawDiff -= Math.PI * 2
          while (yawDiff < -Math.PI) yawDiff += Math.PI * 2
          recoverAngle = yawDiff * 0.5
          s.current.speed *= 0.97
        }
      }
    }

    // Check for player proximity - slow down
    let wantSpeed = carCruise
    let offRoadPenalty = 1
    // Corner speed: cap cruise by lateral acceleration. Heading change across
    // the look-ahead span gives curvature k = dyaw / dist, radius R = 1/k, so
    // v <= sqrt(AI_A_LAT * R) — cars ease off into turns/junctions instead of
    // taking them at flat cruise (which is what made AI traffic look robotic
    // and swipe wide). Straight road: dyaw ~ 0, no cap.
    {
      const laDist = Math.max(4, AI_LOOK_AHEAD_DIST + s.current.speed * 0.3)
      let dYaw = lookAhead.yaw - currentRouteOut.yaw
      while (dYaw > Math.PI) dYaw -= Math.PI * 2
      while (dYaw < -Math.PI) dYaw += Math.PI * 2
      const absYaw = Math.abs(dYaw)
      if (absYaw > 0.06) {
        const radius = Math.min(220, laDist / absYaw)
        const vCorner = Math.sqrt(AI_A_LAT * radius)
        if (vCorner < wantSpeed) wantSpeed = vCorner
      }
    }
    
    try {
      // Check if on road
      const onRoad = isOnAsphalt(currentX, currentZ)
      if (!onRoad) {
        // Off road - penalize speed and steer back to the road NETWORK.
        offRoadPenalty = OFF_ROAD_SPEED_PENALTY

        // Nearest road via the graph's spatial index (nearest junction to
        // this car). The old code scanned only the FIRST 20 segments of
        // window.__gtathensRoadCache — i.e. roads somewhere else on the map —
        // so "recovery" steering pointed at arbitrary streets and off-road
        // cars wandered further off. nearest() ring-searches nearby cells and
        // falls back to a full scan, so this is both correct and cheap.
        const nearRoad = aiPathfinder ? aiPathfinder.nearest(currentX, currentZ, 60) : null
        if (nearRoad && nearRoad.dist > OFF_ROAD_PENALTY_DIST) {
          const roadDir = Math.atan2(nearRoad.x - currentX, nearRoad.z - currentZ)
          let roadYawDiff = roadDir - s.current.yaw
          while (roadYawDiff > Math.PI) roadYawDiff -= Math.PI * 2
          while (roadYawDiff < -Math.PI) roadYawDiff += Math.PI * 2

          // Add strong road recovery steering
          recoverAngle += roadYawDiff * 0.4 * Math.min(1, nearRoad.dist / 10)
          isOffCourse = true
        }
      }
    } catch { /* ignore */ }
    
    // Apply off-road speed penalty before other adjustments
    wantSpeed *= offRoadPenalty
    
    try {
      const p = window.__gtathensPlayer
      if (p) {
        const pd = Math.hypot(p.x - currentX, p.z - currentZ)
        if (pd < 5) wantSpeed = 0
        else if (pd < 10) wantSpeed = carCruise * 0.2 * offRoadPenalty
        else if (pd < 18) wantSpeed = carCruise * 0.5 * offRoadPenalty
        else if (pd < 25) wantSpeed = carCruise * 0.8 * offRoadPenalty
      }
    } catch { /* ignore */ }

    // Collision avoidance with other AI cars
    const others = crash.aiLive
    const [avoidX, avoidZ, imminentCollision] = computeAvoidSteer(
      currentX, currentZ, s.current.yaw, s.current.speed, 
      others, index, route
    )

    // Combine steering: route direction + avoidance + recovery
    let desiredYawWithAvoid = desiredYaw
    
    // Add avoidance steering
    if (Math.abs(avoidX) > 0.01) {
      const steerAngle = Math.atan2(avoidX, 1) * 0.6
      desiredYawWithAvoid += steerAngle
    }

    // Add recovery steering
    if (Math.abs(recoverAngle) > 0.01) {
      desiredYawWithAvoid += recoverAngle
    }

    // Smooth yaw transition with PID-like control
    let yawDiff = desiredYawWithAvoid - s.current.yaw
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2

    // Calculate steering response with proportional + derivative
    const proportional = yawDiff * 3.0
    const derivative = -s.current.speed * 0.02 * Math.sign(yawDiff)
    
    // Limit turn rate based on speed and conditions
    let maxTurn = MAX_STEER_ANGLE * (0.5 + s.current.speed * 0.03)
    maxTurn = Math.min(maxTurn, 0.15)
    
    // Stronger correction when off course
    if (isOffCourse) {
      maxTurn *= 1.3
    }
    
    // Brake for imminent collision
    if (imminentCollision) {
      wantSpeed *= 0.6
    }

    // --- STUCK / REVERSE RECOVERY ---
    // Blocked (player queue, bumper lock, wall) but the route says GO: after
    // ~2.5 s of near-zero motion, back up for ~1.1 s, then re-project. The
    // avoid steer only ever pushes FORWARD, so without this a nose-to-wall
    // state never resolves.

    // Apply smoothed steering. No gas = no turn (same rule as the player's
    // car): the yaw rate scales with actual rolling speed, so a stationary or
    // braking-to-stop AI car holds its heading instead of pivoting in place.
    const steerInputRaw = Math.max(-maxTurn, Math.min(maxTurn, proportional + derivative))
    const rolling = Math.min(1, Math.abs(s.current.speed) / 2)
    const steerInput = steerInputRaw * rolling
    s.current.yaw += steerInput * dt * 12

    // --- STUCK / REVERSE RECOVERY ---
    // Blocked (player queue, bumper lock, wall) but the route says GO: after
    // ~2.5 s of near-zero motion, back up for ~1.1 s, then re-project. The
    // avoid steer only ever pushes FORWARD, so without this a nose-to-wall
    // state never resolves.
    const wantsToGo = wantSpeed > 1.5
    const isCrawling = s.current.speed < 0.6
    if (s.current.reverseT > 0) {
      s.current.reverseT -= dt
    } else if (wantsToGo && isCrawling) {
      s.current.stuckT += dt
      if (s.current.stuckT > AI_STUCK_SECS) {
        s.current.reverseT = AI_REVERSE_SECS
        s.current.stuckT = 0
      }
    } else {
      s.current.stuckT = 0
    }
    const reversing = s.current.reverseT > 0

    // Speed control with smoother acceleration (reverse un-wedge: hold a
    // steady ~2.5 m/s backwards, keep forward logic out of the way).
    const speedError = reversing ? 2.5 - s.current.speed : wantSpeed - s.current.speed
    s.current.speed += speedError * Math.min(1, dt * AI_ACCEL_TAU)
    s.current.speed = Math.max(0, s.current.speed)

    // Calculate velocity from yaw and speed (reverse gear while un-wedging).
    const dirX = Math.sin(s.current.yaw)
    const dirZ = Math.cos(s.current.yaw)
    const gear = reversing ? -1 : 1
    const targetVx = dirX * s.current.speed * gear
    const targetVz = dirZ * s.current.speed * gear

    // Apply velocity
    const v = rb.linvel ? rb.linvel() : { x: 0, y: 0, z: 0 }
    rb.setLinvel({ x: targetVx, y: v.y, z: targetVz }, true)

    // Apply rotation
    const c = Math.cos(s.current.yaw / 2)
    const sinY = Math.sin(s.current.yaw / 2)
    rb.setRotation({ x: 0, y: sinY, z: 0, w: c }, true)

    // Update progress along route: PROJECT the car's real position onto the
    // route every frame (dead-reckoning desynced after bumps/avoids and let
    // cars wander off-road). Wrap at the closed loop length — and when a lap
    // closes, re-plan the loop so traffic keeps exploring new roads.
    // While reversing out of a wedge the projection is meaningless (the car
    // is moving AWAY from the route) — freeze progress so the look-ahead
    // target does not jump, then re-project once rolling forward again.
    if (!reversing) {
      s.current.progress = projectOnRoute(route, currentX, currentZ, s.current.progress, s.current.totalLen)
    }
    if (s.current.progress < 0) s.current.progress += s.current.totalLen
    if (s.current.progress > s.current.totalLen) {
      s.current.progress -= s.current.totalLen
      s.current.lap += 1
      tryReroute(currentX, currentZ)
    }

    // Update live state for other systems
    setAiLive(index, currentX, currentZ)
    try { crash.setAiLive(index, currentX, currentZ) } catch { /* seam not mounted */ }
    try {
      const live = crash.aiLive[index]
      if (live) {
        live.speed = s.current.speed
        live.yaw = s.current.yaw
        // QA (npcsQA.traffic / smoke TRAFFIC TEST): lap counter + loop
        // length let the harness prove cars are re-routing, not just wiggling.
        live.lap = s.current.lap
        live.routeLen = s.current.totalLen
      }
    } catch { /* ignore */ }
    // Visual state for CarWheels (spin/steer/brake lights) — AI braking is
    // decelerating (or waiting on the player).
    const aiBraking = speedError < -0.5 || wantSpeed < 0.5
    try { setAnimAi(index, s.current.speed, steerInputRaw, aiBraking) } catch { /* noop */ }

    // Update visual group position
    if (gRef.current) {
      gRef.current.position.set(currentX, tPos.y - half[1], currentZ)
      gRef.current.rotation.set(0, s.current.yaw, 0)
    }
  })

  return (
    <group ref={gRef} position={[route[0][0], 0, route[0][1]]}>
      <RigidBody
        ref={bodyRef}
        type="dynamic"
        colliders={false}
        position={[route[0][0], half[1], route[0][1]]}
        collisionGroups={AI_CAR_GROUPS}
        mass={1800}
        canSleep={false}
        ccdEnabled
        linearDamping={0.5}
        angularDamping={2.0}
        onCollisionEnter={onHit}
        onContactForce={onForce}
      >
        <CuboidCollider args={[half[0] + 0.05, half[1] + 0.05, half[2] + 0.05]} friction={0.7} restitution={0.20} />
      </RigidBody>
      <group position={[0, 0, 0]}>
        <Suspense fallback={null}>
          <CarModel id={carId} />
          {/* Same spinning wheels + brake lights as the player's car */}
          <CarWheels half={[half[0] + 0.05, half[1] + 0.05, half[2] + 0.05]} carId={carId} aiIndex={index} />
        </Suspense>
      </group>
    </group>
  )
}

// Debug visualization for AI traffic routes
const AiTrafficDebug = () => {
  const [showRoutes, setShowRoutes] = useState(false)
  // Re-render while open: routes are re-planned every lap (AI_ROUTES[i] is
  // swapped in place by tryReroute) and the cars move, so a static snapshot
  // of the lines/spheres goes stale in seconds. 2 Hz is plenty; the interval
  // only exists while the overlay is on.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!showRoutes) return undefined
    const t = setInterval(() => setTick((v) => v + 1), 500)
    return () => clearInterval(t)
  }, [showRoutes])

  // Toggle routes on 'T' key
  useEffect(() => {
    const handleKey = (e) => {
      if (e.code === 'KeyT' && e.target === document.body) {
        setShowRoutes((v) => !v)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  // Expose toggle via window for programmatic control
  useEffect(() => {
    window.__gtathensShowAiRoutes = setShowRoutes
    return () => { delete window.__gtathensShowAiRoutes }
  }, [setShowRoutes])

  if (!showRoutes) return null

  return (
    <>
      {/* Draw route lines */}
      {AI_ROUTES.map((route, i) => {
        if (!route || route.length < 2) return null
        const points = route.map((p) => [p[0], 0.5, p[1]])
        return (
          <Line
            key={`route-${i}`}
            points={points}
            color={CAR_COLORS[i % CAR_COLORS.length]}
            lineWidth={2}
            transparent
            opacity={0.6}
          />
        )
      })}
      {/* Draw current progress markers for each car */}
      {AI_ROUTES.map((route, i) => {
        if (!route || route.length < 2) return null
        const live = crash.aiLive[i]
        if (!live || !Number.isFinite(live.x)) return null

        // Find nearest point on route
        const nearest = findNearestOnRoute(route, live.x, live.z)
        if (!nearest) return null

        // Sample at the car's projected progress (sampling s=0 always parked
        // the cube at the loop start regardless of where the car actually was)
        const routeOut = { x: 0, z: 0, yaw: 0, done: false }
        sampleRoute(route, nearest.t, routeOut)

        return (
          <>
            {/* Current car position */}
            <mesh position={[live.x, 0.3, live.z]}>
              <sphereGeometry args={[0.5, 8, 8]} />
              <meshBasicMaterial color={CAR_COLORS[i % CAR_COLORS.length]} />
            </mesh>
            {/* Progress indicator along route */}
            <mesh position={[routeOut.x, 0.3, routeOut.z]}>
              <boxGeometry args={[1, 0.2, 1]} />
              <meshBasicMaterial color={CAR_COLORS[i % CAR_COLORS.length]} opacity={0.5} transparent />
            </mesh>
          </>
        )
      })}
    </>
  )
}

const Npcs = ({ spawn = [0, 0] }) => {
  const key = `${Math.round(spawn[0] * 10)},${Math.round(spawn[1] * 10)}`
  const [peds, setPeds] = useState([])
  const [routes, setRoutes] = useState([])

  useEffect(() => {
    crash.pedCheck = (orb, speed) => {
      for (let i = 0; i < NPC_RECORDS.length; i += 1) {
        const rec = NPC_RECORDS[i]
        if (rec && !rec.dead && rec.rb === orb) {
          rec.hp = Math.max(0, rec.hp - Math.round(speed * 12))
          if (rec.hp <= 0) {
            rec.dead = true
            rec.deadAt = typeof performance !== 'undefined' ? performance.now() : 0
          }
          try { audio.crash(0.2) } catch {}
          return
        }
      }
    }
    crash.playerCheck = (orb, speed) => {
      if (speed > 3.0) {
        try {
          const gs = useGameStore.getState()
          if (gs && gs.phase === Phase.PLAYING && gs.driving === null) {
            gs.setHealth(Math.max(0, (gs.health ?? 100) - Math.round(speed * 2.0)))
            combat.shake = Math.min(1.0, (combat.shake || 0) + speed * 0.02)
          }
        } catch {}
      }
    }
    return () => {
      crash.pedCheck = null
      crash.playerCheck = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    for (const r of NPC_RECORDS) {
      r.hp = NPC_HP
      r.dead = false
      r.deadAt = 0
      r.killer = null
    }
    AI_CAR_STATE.length = 0
    loadWorldData()
      .then((data) => {
        if (cancelled) return
        const spots = buildPedSpawns(data, spawn, PED_COUNT)
        setPeds(spots.map((p, i) => ({ ...p, dir: hash01(i * 31 + 3) * Math.PI * 2 })))
        const rts = buildAiRoutes(data, spawn, AI_CAR_COUNT)
        for (let i = 0; i < rts.length; i += 1) AI_CAR_STATE.push({ route: i })
        setRoutes(rts)
      })
      .catch((err) => console.error('npcs: map load failed', err))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <>
      {peds.map((p, i) => (
        <Ped key={`${key}-${i}`} index={i} x={p.x} z={p.z} dir={p.dir} />
      ))}
      {routes.map((r, i) => (
        <AiCar key={`${key}-car-${i}`} route={r} seed={i} index={i} />
      ))}
      {/* Debug visualization for AI routes (toggled by 'T' key or window.__gtathensShowAiRoutes) */}
      <AiTrafficDebug />
    </>
  )
}

export { AiTrafficDebug }
export default Npcs
