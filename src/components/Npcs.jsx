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
import { audio } from '../lib/audio'
import Protagonist, { CHARACTERS } from './Protagonist'

export const PED_COUNT = 10
export const PED_RADIUS = 200
export const AI_CAR_COUNT = 8
export const AI_CAR_RADIUS = 280
export const NPC_KILL_TOAST = 'Ped down - cash dropped'
export const NPC_RECORDS = []
export const AI_CAR_STATE = []
// Module-level storage for AI routes (for debug visualization)
export const AI_ROUTES = []
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
  // Loop routes via A* on the ROAD GRAPH (lib/RoadPathfinder.js — the same
  // graph GPS/minimap will use). randomRoute(seed) picks two junctions
  // deterministically, routes start->goal->start, and returns a CLOSED loop,
  // so the car laps a real circuit through live traffic instead of an
  // isolated random walk that used to dead-end on fragmented junctions.
  // Fallback: the old straight-preference random walk, if routing can't
  // produce a loop (e.g. a stub map with no connected junctions).
  let pf = null
  try {
    pf = getRoadPathfinder(data, 'drivable')
  } catch (e) {
    pf = null
  }
  if (pf && pf.size > 4) {
    const routes = []
    for (let k = 0; k < count; k += 1) {
      const r = pf.randomRoute(k * 977 + 13)
      if (r && r.points.length >= 3) routes.push(r.points)
    }
    if (routes.length > 0) {
      // Store routes for debug visualization
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
 */
const getLookAheadTarget = (route, progress, lookAheadDist, totalLen) => {
  const targetS = Math.min(progress + lookAheadDist, totalLen)
  const out = { x: 0, z: 0, yaw: 0, done: false }
  sampleRoute(route, targetS, out)
  return {
    x: out.x,
    z: out.z,
    yaw: out.yaw,
    dist: Math.min(lookAheadDist, totalLen - progress),
  }
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

  const handleCollision = React.useCallback((p) => {
    if (rec && !rec.dead) {
      const orb = p?.other?.rigidBody
      if (orb && typeof orb.linvel === 'function') {
        const lv = orb.linvel()
        const speed = Math.hypot(lv.x, lv.z)
        if (speed > 2.2) {
          rec.hp = 0
          rec.dead = true
          try { audio.crash(Math.min(1.0, 0.35 + speed / 15)) } catch { /* silent */ }
        }
      }
    }
  }, [rec])

  return (
    <group ref={gRef} position={[x, 0, z]} rotation={[0, dir, 0]}>
      <RigidBody
        ref={bodyRef}
        type="kinematicPosition"
        colliders={false}
        position={[0, 0.95, 0]}
        collisionGroups={PED_GROUPS}
        onCollisionEnter={handleCollision}
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

// Road awareness: how far off road before we strongly correct
const OFF_ROAD_PENALTY_DIST = 4
const OFF_ROAD_SPEED_PENALTY = 0.4  // Speed multiplier when off road

const AiCar = ({ route, seed, index = 0 }) => {
  const bodyRef = useRef(null)
  const gRef = useRef(null)
  // State: progress along route as arc-length, position, yaw, speed
  const s = useRef({
    progress: 0,
    x: route[0][0],
    z: route[0][1],
    yaw: 0,
    speed: 0,
    totalLen: polylineLength(route),
    wobble: Math.random() * 100,
  })

  // Initialize AI live state
  if (!crash.aiLive[index] || !Number.isFinite(crash.aiLive[index].x)) {
    crash.setAiLive(index, s.current.x, s.current.z)
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
  // Faster cruise speeds with variety (base 10 m/s ≈ 36 km/h)
  const cruiseMult = 0.9 + (Math.abs(seed) % 100) / 250  // 0.9 to 1.3
  const carCruise = AI_CRUISE * cruiseMult

  useFrame((state, dtRaw) => {
    const rb = bodyRef.current
    if (!rb || typeof rb.translation !== 'function') return
    const dt = Math.min(dtRaw, 0.05)
    const gs = useGameStore.getState()
    if (gs.phase !== Phase.PLAYING) {
      try { rb.setLinvel({ x: 0, y: 0, z: 0 }, true) } catch (e) { /* noop */ }
      return
    }

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
    
    try {
      // Check if on road
      const onRoad = isOnAsphalt(currentX, currentZ)
      if (!onRoad) {
        // Off road - penalize speed and steer back
        offRoadPenalty = OFF_ROAD_SPEED_PENALTY
        
        // Find nearest road point to steer towards
        const roadSegs = window.__gtathensRoadCache?.segs
        if (roadSegs && roadSegs.length > 0) {
          let nearestRoadX = currentX
          let nearestRoadZ = currentZ
          let nearestRoadDist = Infinity
          
          // Sample road segments to find nearest point
          const sampleSteps = Math.min(roadSegs.length, 20)
          for (let i = 0; i < sampleSteps; i += 1) {
            const seg = roadSegs[i]
            const dx = seg.bx - seg.ax
            const dz = seg.bz - seg.az
            const L2 = dx * dx + dz * dz
            let t = L2 > 0 ? ((currentX - seg.ax) * dx + (currentZ - seg.az) * dz) / L2 : 0
            t = Math.max(0, Math.min(1, t))
            const px = seg.ax + dx * t
            const pz = seg.az + dz * t
            const d = Math.hypot(px - currentX, pz - currentZ)
            if (d < nearestRoadDist) {
              nearestRoadDist = d
              nearestRoadX = px
              nearestRoadZ = pz
            }
          }
          
          // If significantly off road, steer towards nearest road point
          if (nearestRoadDist > OFF_ROAD_PENALTY_DIST) {
            const roadDx = nearestRoadX - currentX
            const roadDz = nearestRoadZ - currentZ
            const roadDir = Math.atan2(roadDx, roadDz)
            let roadYawDiff = roadDir - s.current.yaw
            while (roadYawDiff > Math.PI) roadYawDiff -= Math.PI * 2
            while (roadYawDiff < -Math.PI) roadYawDiff += Math.PI * 2
            
            // Add strong road recovery steering
            recoverAngle += roadYawDiff * 0.4 * Math.min(1, nearestRoadDist / 10)
            isOffCourse = true
          }
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

    // Apply smoothed steering
    const steerInput = Math.max(-maxTurn, Math.min(maxTurn, proportional + derivative))
    s.current.yaw += steerInput * dt * 12

    // Speed control with smoother acceleration
    const speedError = wantSpeed - s.current.speed
    s.current.speed += speedError * Math.min(1, dt * AI_ACCEL_TAU)
    s.current.speed = Math.max(0, s.current.speed)

    // Calculate velocity from yaw and speed
    const dirX = Math.sin(s.current.yaw)
    const dirZ = Math.cos(s.current.yaw)
    const targetVx = dirX * s.current.speed
    const targetVz = dirZ * s.current.speed

    // Apply velocity
    const v = rb.linvel ? rb.linvel() : { x: 0, y: 0, z: 0 }
    rb.setLinvel({ x: targetVx, y: v.y, z: targetVz }, true)

    // Apply rotation
    const c = Math.cos(s.current.yaw / 2)
    const sinY = Math.sin(s.current.yaw / 2)
    rb.setRotation({ x: 0, y: sinY, z: 0, w: c }, true)

    // Update progress along route
    const moveAlign = dirX * Math.sin(desiredYaw) + dirZ * Math.cos(desiredYaw)
    
    if (distToRoute < AI_RECOVER_DIST) {
      if (moveAlign > 0.3) {
        const progressRate = s.current.speed * dt * (0.8 + moveAlign * 0.2)
        s.current.progress += progressRate
        if (s.current.progress > s.current.totalLen) {
          s.current.progress -= s.current.totalLen
        }
      }
    } else {
      s.current.progress += s.current.speed * dt * 0.2
      if (s.current.progress > s.current.totalLen) {
        s.current.progress -= s.current.totalLen
      }
    }

    // Update progress along route (only when close to route)

    // Update live state for other systems
    setAiLive(index, currentX, currentZ)
    try { crash.setAiLive(index, currentX, currentZ) } catch { /* seam not mounted */ }
    try {
      const live = crash.aiLive[index]
      if (live) {
        live.speed = s.current.speed
        live.yaw = s.current.yaw
      }
    } catch { /* ignore */ }

    // Update visual group position
    if (gRef.current) {
      gRef.current.position.set(currentX, tPos.y - half[1], currentZ)
      gRef.current.rotation.set(0, s.current.yaw, 0)
    }
  })

  const onHit = React.useCallback((p) => crashHitFromPayload(p, null, false, 0, index), [index])
  const onForce = React.useCallback((p) => crashHitFromPayload(p, null, true, p?.totalForceMagnitude ?? 0, index), [index])

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
        </Suspense>
      </group>
    </group>
  )
}

// Debug visualization for AI traffic routes
const AiTrafficDebug = () => {
  const [showRoutes, setShowRoutes] = useState(false)

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

        // Sample route at progress
        const routeOut = { x: 0, z: 0, yaw: 0, done: false }
        sampleRoute(route, 0, routeOut)

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
