// Pedestrians + AI traffic. Peds are kinematic capsules; HP lives on the
// MODULE record (NPC_RECORDS) - WeaponController hits set dead, render does
// fall + drops via spawnDrop(). Traffic loops the road graph.
import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
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
import { getRoadPathfinder } from '../lib/RoadPathfinder'
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
  addAiDamage,
  getCarBody,
  isAiCarOccupied,
  setAiCarOccupied,
  setAiLive,
} from './Car'
import { audio } from '../lib/audio'
import Protagonist, { CHARACTERS } from './Protagonist'

export const PED_COUNT = 30
export const PED_RADIUS = 220
export const AI_CAR_COUNT = 12
export const AI_CAR_RADIUS = 300
export const NPC_KILL_TOAST = 'Ped down - cash dropped'
export const NPC_RECORDS = []
export const AI_CAR_STATE = []
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
const AI_CRUISE = 8
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
    if (routes.length > 0) return routes
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

    // Handle dead state (fall flat on asphalt)
    if (rec.dead) {
      if (gRef.current) {
        // Smoothly lay flat on ground
        s.fallPitch = THREE.MathUtils.lerp(s.fallPitch || 0, Math.PI / 2, Math.min(1, dt * 10))
        gRef.current.rotation.set(s.fallPitch, s.yaw, 0)
        gRef.current.position.set(s.px, 0.22, s.pz)
      }
      if (!s.deadNotified) {
        s.deadNotified = true
        try {
          const t = rb ? rb.translation() : { x: s.px, z: s.pz }
          spawnDrop('money', t.x, t.z, 10 + Math.floor(Math.random() * 35))
          spawnDrop('ammo', t.x + 0.5, t.z + 0.4, 15 + Math.floor(Math.random() * 25))
        } catch (e) { /* noop */ }
        if (gs.pushToast) gs.pushToast(NPC_KILL_TOAST, 'info')
        if (gs.addKill) gs.addKill()
        setAction('idle')
      }
      return
    }

    if (gs.phase !== Phase.PLAYING) return

    // Check collision / hit by cars (player driven or AI traffic)
    try {
      // Check player driven car
      const drivingIdx = gs.driving
      if (drivingIdx !== null && drivingIdx !== undefined) {
        const carRb = crash.bodies[drivingIdx]
        if (carRb && typeof carRb.translation === 'function') {
          const ct = carRb.translation()
          const cv = carRb.linvel ? carRb.linvel() : { x: 0, z: 0 }
          const cSpeed = Math.hypot(cv.x, cv.z)
          const dist = Math.hypot(ct.x - s.px, ct.z - s.pz)
          if (cSpeed > 1.8 && dist < 2.2) {
            rec.dead = true
            try { audio.crash(0.5) } catch { /* noop */ }
          }
        }
      }

      // Check AI cars
      if (!rec.dead) {
        for (let k = 0; k < AI_CAR_BODIES.length; k += 1) {
          const aiRb = AI_CAR_BODIES[k]
          if (!aiRb || typeof aiRb.translation !== 'function') continue
          const ct = aiRb.translation()
          const cv = aiRb.linvel ? aiRb.linvel() : { x: 0, z: 0 }
          const cSpeed = Math.hypot(cv.x, cv.z)
          const dist = Math.hypot(ct.x - s.px, ct.z - s.pz)
          if (cSpeed > 2.0 && dist < 2.0) {
            rec.dead = true
            try { audio.crash(0.5) } catch { /* noop */ }
            break
          }
        }
      }
    } catch { /* ignore */ }

    if (rec.dead) return
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
    if (heading === undefined) heading = s.yaw + wob * 0.2

    // Smooth heading rotation with lerp
    let diff = heading - s.yaw
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))
    s.yaw += diff * Math.min(1, dt * 6.0)

    let nx = s.px + Math.sin(s.yaw) * PED_SPEED * dt
    let nz = s.pz + Math.cos(s.yaw) * PED_SPEED * dt
    try {
      const t = rb.translation()
      const pushed = Math.hypot(t.x - s.px, t.z - s.pz)
      if (pushed > 0.08 && pushed < 6) {
        nx = t.x + Math.sin(s.yaw) * PED_SPEED * dt
        nz = t.z + Math.cos(s.yaw) * PED_SPEED * dt
      }
    } catch (e) { /* noop */ }
    if (!s.navPath && Math.random() < dt * 0.03) s.yaw += (Math.random() - 0.5) * 0.8
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

const CAR_COLORS = ['#c0392b', '#2980b9', '#7f8c8d', '#f39c12', '#27ae60']

const AiCar = ({ route, seed, index = 0 }) => {
  const bodyRef = useRef(null)
  const gRef = useRef(null)
  const st = useRef({ seg: 0, x: route[0][0], z: route[0][1], yaw: 0, speed: 0 })
  const s = st.current

  if (!crash.aiLive[index] || !Number.isFinite(crash.aiLive[index].x)) {
    crash.setAiLive(index, s.x, s.z)
  }

  const AI_CAR_IDS = ['sedan', 'taxi', 'hatchback', 'sports', 'suv', 'pickup', 'van', 'police-sedan']
  const carId = AI_CAR_IDS[Math.abs(seed) % AI_CAR_IDS.length] || 'sedan'
  const half = HALF[carId] || HALF.sedan

  useFrame((state, dtRaw) => {
    const rb = bodyRef.current
    if (!rb || typeof rb.translation !== 'function') return
    const dt = Math.min(dtRaw, 0.05)
    const gs = useGameStore.getState()
    if (gs.phase !== Phase.PLAYING) {
      try { rb.setLinvel({ x: 0, y: 0, z: 0 }, true) } catch (e) { /* noop */ }
      return
    }

    const tPos = rb.translation()
    s.x = tPos.x
    s.z = tPos.z

    const b = route[s.seg + 1] || route[0]
    let dx = b[0] - s.x
    let dz = b[1] - s.z
    let distToWp = Math.hypot(dx, dz)
    if (distToWp < 3.5) {
      s.seg = (s.seg + 1) % Math.max(1, route.length - 1)
    }

    if (distToWp < 0.001) { dx = 0; dz = 1; distToWp = 1 }
    const dirX = dx / distToWp
    const dirZ = dz / distToWp
    s.yaw = Math.atan2(dirX, dirZ)

    let want = AI_CRUISE
    try {
      const p = window.__gtathensPlayer
      if (p) {
        const pd = Math.hypot(p.x - s.x, p.z - s.z)
        if (pd < 6) want = 0
        else if (pd < 12) want = AI_CRUISE * 0.3
      }
      const others = crash.aiLive
      for (let k = 0; k < others.length; k += 1) {
        if (k === index) continue
        const o = others[k]
        if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z)) continue
        const odx = o.x - s.x
        const odz = o.z - s.z
        const od = Math.hypot(odx, odz)
        const dot = odx * dirX + odz * dirZ
        if (od < 5.5 && dot > 0) {
          want = 0
          break
        }
      }
    } catch { /* ignore */ }

    s.speed += (want - s.speed) * Math.min(1, dt * 3.0)
    const targetVx = dirX * s.speed
    const targetVz = dirZ * s.speed

    const v = rb.linvel ? rb.linvel() : { x: 0, y: 0, z: 0 }
    rb.setLinvel({ x: targetVx, y: v.y, z: targetVz }, true)

    const c = Math.cos(s.yaw / 2)
    const sinY = Math.sin(s.yaw / 2)
    rb.setRotation({ x: 0, y: sinY, z: 0, w: c }, true)

    setAiLive(index, s.x, s.z)
    try { crash.setAiLive(index, s.x, s.z) } catch { /* seam not mounted */ }
    try {
      const live = crash.aiLive[index]
      if (live) live.speed = s.speed
    } catch { /* ignore */ }

    if (gRef.current) {
      gRef.current.position.set(s.x, tPos.y - half[1], s.z)
      gRef.current.rotation.set(0, s.yaw, 0)
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
        onCollisionEnter={(p) => { try { audio.crash(0.3) } catch { /* ignore */ } }}
      >
        <CuboidCollider args={[half[0], half[1], half[2]]} friction={0.9} restitution={0.05} />
      </RigidBody>
      <group position={[0, 0, 0]}>
        <CarModel id={carId} />
      </group>
    </group>
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
    </>
  )
}

export default Npcs
