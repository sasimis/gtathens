// src/driving/TrafficCars.jsx
// AI traffic for the driving test scene. Same recipe as the main game's
// Npcs.jsx AiCar: closed-loop routes from the OSM road graph
// (RoadPathfinder.randomRoute → sampleRoute arc-length walking), right-hand
// lane offset, look-ahead steering, per-frame PROJECTION of the real body
// position back onto the route, plus traffic-rule compliance: red-light stops,
// stop-sign behavior at unsignalized junctions, and leader-following braking.
// Live positions publish into `crash.setAiLive` so collision avoidance and the
// QA hooks see them.
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import { loadWorldData } from '../lib/worldData'
import { sampleRoute, polylineLength } from '../lib/RoadPathfinder'
import { HALF, GROUP_CAR, FILTER_ALL } from '../components/car-modules/constants.js'
import { CarModel } from '../components/car-modules/CarModel.jsx'
import { CarWheels } from '../components/car-modules/CarWheels.jsx'
import { crash } from '../components/car-modules/crashManager.js'
import { setAnimAi } from '../components/car-modules/carVisuals.js'
import useGameStore, { Phase } from '../store/useGameStore'
import {
  buildLightPlan, lightState, shouldStopAtLight, getNearestLight,
  initCarState, getCarState, clearTraffic, setCarLights,
} from './TrafficState.jsx'

// Tuning (kept close to the main game's AI traffic)
const LOOK_AHEAD = 10        // m of route ahead used as the steer target
const CRUISE = 9             // m/s ≈ 32 km/h
const ACCEL_TAU = 2.5        // speed smoothing
const MAX_TURN = 0.45        // rad/s cap at rolling speed
const PROJ_WINDOW = 12       // re-projection search window around the guess
const BRAKE_DIST = 9         // start braking this close to an obstacle
const STOP_DIST = 5          // full stop inside this radius
const LANE_WIDTH = 3.6       // standard lane width; right-of-center split
const LANE_HALF = LANE_WIDTH / 2
const STOP_SIGN_HOLD_MS = 2000  // dwell at an unsignalized junction
const AI_CAR_GROUPS = GROUP_CAR | (FILTER_ALL << 16)

const AI_CAR_IDS = ['sedan', 'sedan-blue', 'sports', 'muscle', 'suv', 'sedan-darkred']

// Module-level scratch — NO per-frame allocation (see the GC gotcha).
const sampleOut = { x: 0, z: 0, yaw: 0, done: false }
const PROJ_STEP = 2


/**
 * PROJECT the real XZ position onto the route near an arc-length guess.
 * Same idea as Npcs.jsx's projectOnRoute: search ±PROJ_WINDOW around sGuess,
 * returning the corrected arc length (closed loops wrap via the caller).
 */
const projectOnRoute = (route, x, z, sGuess, totalLen) => {
  let bestS = sGuess
  let bestD = Infinity
  const lo = sGuess - PROJ_WINDOW
  const hi = sGuess + PROJ_WINDOW
  const n = route.length
  // Closed loop: also test the wrap segment (last -> first).
  const closed = route[0][0] === route[n - 1][0] && route[0][1] === route[n - 1][1]
  const segCount = closed ? n - 1 : n
  let acc = 0
  for (let i = 0; i < segCount; i += 1) {
    const a = route[i]
    const b = route[(i + 1) % n]
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const segLen = Math.hypot(dx, dz)
    if (segLen < 1e-6) continue
    const sLo = Math.max(acc, lo)
    const sHi = Math.min(acc + segLen, hi)
    if (sLo < sHi) {
      for (let s = sLo; s <= sHi; s += PROJ_STEP) {
        const t = (s - acc) / segLen
        const px = a[0] + dx * t
        const pz = a[1] + dz * t
        const d = (px - x) * (px - x) + (pz - z) * (pz - z)
        if (d < bestD) { bestD = d; bestS = s }
      }
    }
    acc += segLen
  }
  if (bestD === Infinity) return sGuess
  // Sample the winner's neighbourhood once more for sub-step precision.
  let fine = bestS
  let fineD = bestD
  for (let s = bestS - PROJ_STEP; s <= bestS + PROJ_STEP; s += 0.5) {
    const ss = ((s % totalLen) + totalLen) % totalLen
    sampleRoute(route, ss, sampleOut)
    const d = (sampleOut.x - x) * (sampleOut.x - x) + (sampleOut.z - z) * (sampleOut.z - z)
    if (d < fineD) { fineD = d; fine = ss }
  }
  return fine
}

/** Distance + "is it ahead of us" test against one obstacle {x,z}. */
const obstacleAhead = (x, z, sinY, cosY, ox, oz, out) => {
  const dx = ox - x
  const dz = oz - z
  const d2 = dx * dx + dz * dz
  if (d2 > 400) return false // 20 m — anything farther is irrelevant
  // "Ahead" = positive dot with our forward vector (sin yaw, cos yaw).
  const fwd = dx * sinY + dz * cosY
  if (fwd < 0.5) return false
  if (d2 < out.bestD2) out.bestD2 = d2
  return true
}

const TrafficCar = ({ route, lights, index }) => {
  const bodyRef = useRef(null)
  const gRef = useRef(null)
  const carId = AI_CAR_IDS[index % AI_CAR_IDS.length]
  const half = HALF[carId] || HALF.sedan
  const st = useRef({
    progress: 0,
    yaw: 0,
    speed: 0,
    totalLen: polylineLength(route),
    init: false,
  })
  // carState holds lane / stopped / whichLight / junction dwell timer.
  const cs = initCarState(index)
  // Scratch reused across frames (look-ahead sampling, obstacle scan).
  const scan = useRef({ bestD2: Infinity })
  const sOut = useRef({ x: 0, z: 0, yaw: 0, done: false })

  // Init AI live state; on unmount park it off-map so other scanners ignore it.
  useEffect(() => {
    if (!crash.aiLive[index] || !Number.isFinite(crash.aiLive[index].x)) {
      crash.setAiLive(index, route[0][0], route[0][1])
    }
    return () => { try { crash.setAiLive(index, NaN, NaN) } catch { /* noop */ } }
  }, [index, route])


  useFrame((_, dtRaw) => {
    const rb = bodyRef.current
    if (!rb || typeof rb.translation !== 'function') return
    const dt = Math.min(dtRaw, 0.05)
    const s = st.current
    const gs = useGameStore.getState()
    if (gs.phase !== Phase.PLAYING) {
      try { rb.setLinvel({ x: 0, y: 0, z: 0 }, true) } catch { /* noop */ }
      return
    }

    const t = rb.translation()
    const x = t.x
    const z = t.z

    if (!s.init) {
      s.init = true
      // Start facing along the route (sample the very start of the loop).
      sampleRoute(route, 0, sOut.current)
      s.yaw = sOut.current.yaw
    }

    // --- route progress: PROJECT the real position (never dead-reckon) ---
    s.progress = projectOnRoute(route, x, z, s.progress, s.totalLen)

        // --- look-ahead target with right-hand lane offset ---
    // Lane is a half-cell split of the ribbon: right lane (0) sits right of
    // centerline, left lane sits left. 50/50 assignment per car via initCarState.
    const targetS = (s.progress + LOOK_AHEAD) % s.totalLen
    sampleRoute(route, targetS, sOut.current)
    const laneSign = cs.lane === 0 ? -1 : 1
    const laneOffsetX = Math.cos(sOut.current.yaw) * laneSign * LANE_HALF
    const laneOffsetZ = -Math.sin(sOut.current.yaw) * laneSign * LANE_HALF
    const tx = sOut.current.x + laneOffsetX
    const tz = sOut.current.z + laneOffsetZ

    const desiredYaw = Math.atan2(tx - x, tz - z)
    let yawDiff = desiredYaw - s.yaw
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2

    // --- speed target with obstacle braking ---
    let wantSpeed = CRUISE
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const sinY = Math.sin(s.yaw)
    const cosY = Math.cos(s.yaw)
    const sc = scan.current

    // Red-light compliance: if entering an approach that's red/amber, stop.
    let atRed = false
    if (lights && lights.length > 0) {
      const light = getNearestLight(lights, x, z)
      if (light && shouldStopAtLight(light, now)) {
        atRed = true
        cs.whichLight = light.id
      } else {
        cs.whichLight = -1
      }
    }

    // Obstacle scan: other AI cars + parked/driven test cars + on-foot player.
    sc.bestD2 = Infinity
    const others = crash.aiLive
    for (let i = 0; i < others.length; i += 1) {
      if (i === index) continue
      const o = others[i]
      if (!o || !Number.isFinite(o.x)) continue
      obstacleAhead(x, z, sinY, cosY, o.x, o.z, sc)
    }
    const livePos = crash.livePos
    for (let i = 0; i < livePos.length; i += 1) {
      const lp = livePos[i]
      if (!lp || !Number.isFinite(lp.x)) continue
      obstacleAhead(x, z, sinY, cosY, lp.x, lp.z, sc)
    }
    try {
      const p = window.__gtathensPlayer
      if (p && Number.isFinite(p.x)) {
        const dx = p.x - x
        const dz = p.z - z
        const d2 = dx * dx + dz * dz
        if (d2 < 400 && (dx * sinY + dz * cosY) > 0.5) {
          if (d2 < sc.bestD2) sc.bestD2 = d2
        }
      }
    } catch (e) { /* noop */ }

    if (atRed) {
      // Stop for the red light; hold for a minimum dwell so we don't creep.
      if (!cs.stopped || cs.stoppedT === 0) { cs.stopped = true; cs.stoppedT = now }
      wantSpeed = 0
    } else if (Number.isFinite(sc.bestD2)) {
      const d = Math.sqrt(sc.bestD2)
      if (d < STOP_DIST) { wantSpeed = 0; cs.stopped = true; if (!cs.stoppedT) cs.stoppedT = now }
      else if (d < BRAKE_DIST) {
        wantSpeed = CRUISE * ((d - STOP_DIST) / (BRAKE_DIST - STOP_DIST)) * 0.6
        cs.stopped = false; cs.stoppedT = 0
      } else { cs.stopped = false; cs.stoppedT = 0 }
    } else {
      cs.stopped = false; cs.stoppedT = 0
    }

    // Stop-sign / unsignalized junction: holding the stop long enough = proceed.
    if (cs.stopped && cs.stoppedT && !atRed) {
      if (now - cs.stoppedT > STOP_SIGN_HOLD_MS) { cs.stopped = false; cs.stoppedT = 0 }
    }

    // --- steering + speed integration ---
    const steerRaw = Math.max(-MAX_TURN, Math.min(MAX_TURN, yawDiff * 3.0))
    // No gas = no turn (same rule as the player's car): yaw rate scales with
    // actual rolling speed so a braking/stopped AI car holds its heading.
    const rolling = Math.min(1, Math.abs(s.speed) / 2)
    const steerInput = steerRaw * rolling
    s.yaw += steerInput * dt * 12

    const speedError = wantSpeed - s.speed
    s.speed += speedError * Math.min(1, dt * ACCEL_TAU)
    if (s.speed < 0) s.speed = 0

    const dirX = Math.sin(s.yaw)
    const dirZ = Math.cos(s.yaw)
    let vy = 0
    try { vy = rb.linvel().y } catch { /* noop */ }
    rb.setLinvel({ x: dirX * s.speed, y: vy, z: dirZ * s.speed }, true)
    const c = Math.cos(s.yaw / 2)
    const sn = Math.sin(s.yaw / 2)
    rb.setRotation({ x: 0, y: sn, z: 0, w: c }, true)

        // Publish live state + wheel/brake-light animation
    crash.setAiLive(index, x, z)
    try {
      const live = crash.aiLive[index]
      if (live) {
        live.speed = s.speed
        live.yaw = s.yaw
        live.lane = cs.lane
        live.atRed = atRed
        live.stopped = cs.stopped
      }
    } catch (e) { /* noop */ }
    const braking = speedError < -0.5 || wantSpeed < 0.5 || atRed || s.speed < 0.5
    try { setAnimAi(index, s.speed, steerRaw, braking) } catch (e) { /* noop */ }

    if (gRef.current) {
      gRef.current.position.set(x, t.y - half[1], z)
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
        mass={1400}
        canSleep={false}
        ccdEnabled
        linearDamping={0.5}
        angularDamping={2.0}
      >
        <CuboidCollider args={[half[0] + 0.05, half[1] + 0.05, half[2] + 0.05]} friction={0.7} restitution={0.2} />
      </RigidBody>
      <Suspense fallback={null}>
        <CarModel id={carId} />
        <CarWheels half={[half[0] + 0.05, half[1] + 0.05, half[2] + 0.05]} carId={carId} aiIndex={index} />
      </Suspense>
    </group>
  )
}

// How many AI cars loop the graph in the test scene.
const TRAFFIC_COUNT = 6

const TrafficCars = () => {
  const [plan, setPlan] = useState(null)
  useEffect(() => {
    let cancelled = false
    clearTraffic() // fresh AI state on (re)mount
    loadWorldData()
      .then((data) => {
        if (cancelled || !data) return
        const { pf, lights } = buildLightPlan(data)
        if (lights && lights.length > 0) setCarLights(lights)
        if (!pf || pf.size <= 4) return
        const rts = []
        for (let k = 0; k < TRAFFIC_COUNT; k += 1) {
          const r = pf.randomRoute(k * 977 + 13) // same seed recipe as Npcs.jsx
          if (r && r.points.length >= 3) rts.push(r.points)
        }
        if (rts.length > 0) setPlan({ routes: rts })
      })
      .catch(() => { /* no map data — scene stays traffic-free */ })
    return () => { cancelled = true }
  }, [])
  if (!plan) return null
  return (
    <>
      {plan.routes.map((r, i) => (
        <TrafficCar key={i} route={r} index={i} />
      ))}
    </>
  )
}

export default TrafficCars
