/**
 * Driving Test Scene — a lightweight playground that loads ONLY the driving
 * system (cars + on-foot enter/exit + CarDriver + camera). No City, Npcs,
 * Pickups, NavMesh, Protagonist model, WeaponController, or DayNightCycle.
 *
 * Load it at: http://127.0.0.1:5173/driving.html
 *
 * All real driving code (Car, CarDriver, crashManager, CameraRig) is reused
 * from car-modules/ — any tuning change there flows straight into this scene.
 */
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Physics, RigidBody, CapsuleCollider, CuboidCollider, useRapier } from '@react-three/rapier'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import useGameStore, { Phase } from '../store/useGameStore'
import { Car } from '../components/car-modules/Car.jsx'
import { CarDriver, LooseSettler } from '../components/car-modules/CarDriver.jsx'
import { CameraRig, OrbitInput, orbit } from '../components/FollowCamera.jsx'
import Roads from '../components/Roads.jsx'
  import TrafficCars from './TrafficCars.jsx'
import { getCarState, lightState, clearTraffic, setCarLights } from './TrafficState.jsx'
import { loadWorldData } from '../lib/worldData'
import {
  HALF,
  GROUP_GROUND,
  FILTER_ALL,
  PLAYER_COLLISION_GROUPS,
} from '../components/car-modules/constants.js'
import { crash, CAR_LIVE_POS } from '../components/car-modules/crashManager.js'
import { normalizeId } from '../components/car-modules/utils/misc.js'
import { getDrivePad, readStick, padEdge, BTN, padHeld } from '../lib/gamepad.js'
import { audio } from '../lib/audio'

// ---------------------------------------------------------------------------
// Real OSM roads for the test scene: same map_data.json as the main game.
// Renders the Roads.jsx ribbons AND republishes window.__gtathensRoadCache
// (crashManager.isOnAsphalt reads it — full grip on asphalt, 0.55x off-road).
// The test cars are hardcoded around the origin; the map's road network runs
// through world origin by construction (the main game's spawn is (0,0)-anchored
// on the OSM crop), so cars start on/near real streets.
// ---------------------------------------------------------------------------
const TestRoads = () => {
  const [roads, setRoads] = useState(null)
  useEffect(() => {
    let cancelled = false
    loadWorldData()
      .then((data) => {
        if (cancelled || !data) return
        setRoads(data.roads || [])
      })
      .catch(() => { /* no map data — scene stays on the bare ground plane */ })
    return () => { cancelled = true }
  }, [])
  if (!roads) return null
  return <Roads roads={roads} />
}

const GROUND_GROUPS = GROUP_GROUND | (FILTER_ALL << 16)

// Hardcoded test car layout — no map_data.json fetch, instant load.
// 5 cars spaced around the origin so you can drive between them
// and ram parked ones to test crashes. All positions in world meters.
const TEST_CARS = [
  { id: 'sedan',      position: [0, 0.05, 0],     rotation: 0 },
  { id: 'sports',     position: [10, 0.05, 6],    rotation: 0.8 },
  { id: 'muscle',     position: [-10, 0.05, -6],  rotation: Math.PI },
  { id: 'suv',        position: [0, 0.05, -12],   rotation: -Math.PI / 4 },
  { id: 'sedan-blue', position: [12, 0.05, -4],  rotation: Math.PI / 3 },
]

const ENTER_RANGE = 3.4
const ENTER_RANGE_SQ = ENTER_RANGE * ENTER_RANGE
const EXIT_KEEP_RANGE_SQ = 4.2 * 4.2

// Capsule dimensions (same as the on-foot player in the main game)
const CAPSULE_HALF = 0.6
const CAPSULE_RADIUS = 0.35
const COLLIDER_CENTER_Y = CAPSULE_HALF + CAPSULE_RADIUS
const SPAWN_Y = COLLIDER_CENTER_Y
const MODEL_Y = -COLLIDER_CENTER_Y

// Stable QA trace (same pattern as Player.jsx — one object, written in place)
const playerTrace = { x: 0, y: 0, z: 0, camYaw: 0, t: 0 }
if (typeof window !== 'undefined') window.__gtathensPlayer = playerTrace

// ---------------------------------------------------------------------------
// Minimal on-foot controller — just enough to walk to a car and press F.
// Reuses the exact WASD/camera/enter logic from the main game's Player,
// but without Protagonist model, WeaponController, BulletFx, or animations.
// ---------------------------------------------------------------------------
const DriveTestPlayer = ({ spots }) => {
  const phase = useGameStore((s) => s.phase)
  const setNearCar = useGameStore((s) => s.setNearCar)
  const setDriving = useGameStore((s) => s.setDriving)
  const driving = useGameStore((s) => s.driving)
  const respawn = useGameStore((s) => s.respawn)
  const clearRespawn = useGameStore((s) => s.clearRespawn)
  const { world, rapier } = useRapier()

  // Refs are OWNED by this instance (never handed down from the parent): the
  // parent's copy survives the enter/exit unmount, so a stale body handle could
  // outlive the body. The main game's Player/CarDriver each own their refs and
  // their own CameraRig — this mirrors that.
  const bodyRef = useRef(null)
  const modelRef = useRef(null)

  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const drivingRef = useRef(driving)
  drivingRef.current = driving

  // Own ref for the free-orbit yaw (movement basis + CameraRig's yawRef).
  const camYaw = useRef(Math.PI)
  const yaw = useRef(Math.PI)
  const vel = useRef(new THREE.Vector3())
  const pos = useRef(new THREE.Vector3())
  const nearRef = useRef(-1)
  const mountedAt = useRef(typeof performance !== 'undefined' ? performance.now() : 0)

  // Pick up respawn position (set by exitCar when leaving a vehicle)
  const rp = respawn
  const spRef = useRef(null)
  if (spRef.current === null) {
    spRef.current = rp ? [rp.x, rp.z] : [4, 0]
    if (rp?.yaw != null) {
      camYaw.current = rp.yaw
      yaw.current = rp.yaw
    }
  }

  // QA: which spawn this instance mounted with (diagnoses the exit handoff).
  useEffect(() => {
    window.__gtathensPlayerSpawn = { x: spRef.current[0], z: spRef.current[1] }
  }, [])

  // Consume the respawn on mount (same pattern as PlayerBody)
  useEffect(() => {
    if (respawn) clearRespawn()
  }, [respawn, clearRespawn])

  // QA hook: teleport the on-foot player
  useEffect(() => {
    window.__gtathensTp = (x, z, facingYaw = null) => {
      const body = bodyRef.current
      if (!body || typeof body.setTranslation !== 'function') return 'no body'
      body.setTranslation({ x, y: COLLIDER_CENTER_Y + 0.02, z }, true)
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      if (Number.isFinite(facingYaw)) {
        camYaw.current = facingYaw
        yaw.current = facingYaw
      }
      return { x, z }
    }
    return () => { delete window.__gtathensTp }
  }, [bodyRef])

  // Mouse drag for camera yaw
  useEffect(() => {
    let dragging = false
    let lastX = 0
    const down = (e) => { dragging = true; lastX = e.clientX }
    const move = (e) => {
      if (!dragging) return
      camYaw.current -= (e.clientX - lastX) * 0.004
      lastX = e.clientX
    }
    const up = () => { dragging = false }
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
    }
  }, [])

  // WASD + Space keys (same pattern as CarDriver — raw window listeners)
  const keys = useRef({ fwd: false, back: false, left: false, right: false, brake: false })
  useEffect(() => {
    const KEY_MAP = {
      KeyW: 'fwd', ArrowUp: 'fwd',
      KeyS: 'back', ArrowDown: 'back',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right',
      Space: 'brake',
    }
    const down = (e) => { const a = KEY_MAP[e.code]; if (a) keys.current[a] = true }
    const up = (e) => { const a = KEY_MAP[e.code]; if (a) keys.current[a] = false }
    const blur = () => Object.keys(keys.current).forEach((k) => (keys.current[k] = false))
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      Object.keys(keys.current).forEach((k) => (keys.current[k] = false))
    }
  }, [])

  // F key — enter nearest car (same 350ms anti-double-tap as CarDriver)
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'KeyF' || e.repeat) return
      if (phaseRef.current !== Phase.PLAYING) return
      if (drivingRef.current !== null) return
      if (performance.now() - mountedAt.current < 350) return
      if (nearRef.current < 0) return
      setDriving(nearRef.current)
      audio.play('door')
    }
        window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setDriving])

  // Poll for nearby cars every 100ms (same hysteresis as CarEntrance in Player.jsx)
  useEffect(() => {
    const timer = setInterval(() => {
      const body = bodyRef.current
      if (!body || typeof body.translation !== 'function') return
      if (phaseRef.current !== Phase.PLAYING) return
      if (drivingRef.current !== null) {
        if (nearRef.current !== -1) {
          nearRef.current = -1
          setNearCar(-1)
        }
        return
      }
      const t = body.translation()
      pos.current.set(t.x, t.y, t.z)

      // Hysteresis: if we're still inside the exit-keep range of the current
      // best, don't re-evaluate (prevents the F prompt from flickering).
      if (nearRef.current >= 0 && nearRef.current < spots.length) {
        const s = spots[nearRef.current]
        const lp = CAR_LIVE_POS[nearRef.current]
        const sx = lp ? lp.x : s.position[0]
        const sz = lp ? lp.z : s.position[2]
        const dx = pos.current.x - sx
        const dz = pos.current.z - sz
        if (dx * dx + dz * dz < EXIT_KEEP_RANGE_SQ) return
      }

      let best = -1
      let bestD = ENTER_RANGE_SQ
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i]
        const lp = CAR_LIVE_POS[i]
        const sx = lp ? lp.x : s.position[0]
        const sz = lp ? lp.z : s.position[2]
        const dx = pos.current.x - sx
        const dz = pos.current.z - sz
        const d = dx * dx + dz * dz
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best !== nearRef.current) {
        nearRef.current = best
        setNearCar(best >= 0 ? best : -1)
      }
    }, 100)
    return () => {
      clearInterval(timer)
      nearRef.current = -1
      setNearCar(-1)
    }
      }, [bodyRef, spots, setNearCar])

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05)
    const body = bodyRef.current
    if (!body || typeof body.translation !== 'function') return
    if (phaseRef.current !== Phase.PLAYING) return

    const WALK_SPEED = 3.2
    const RUN_SPEED = 6.6
    const ACCEL = 16
    const sinC = Math.sin(camYaw.current)
    const cosC = Math.cos(camYaw.current)

    let ix = (keys.current.right ? 1 : 0) - (keys.current.left ? 1 : 0)
    let iz = (keys.current.fwd ? 1 : 0) - (keys.current.back ? 1 : 0)
    // Gamepad on-foot: left stick moves (same mapping as the main Player).
    // Without this the test scene is keyboard-only on foot, which reads as
    // "controller not working" before you ever get into a car.
    try {
      const pad = getDrivePad()
      if (pad) {
        const sx = readStick(pad, 0)
        const sz = -readStick(pad, 1)
        if (Math.abs(sx) > 0.02 || Math.abs(sz) > 0.02) {
          ix += sx
          iz += sz
        }
        // A button = enter nearest car (same as F). setDriving is a stable
        // store action, so capturing it here is safe.
        if (nearRef.current >= 0 && padEdge(pad, BTN.A)) {
          if (performance.now() - mountedAt.current >= 350) {
            setDriving(nearRef.current)
            audio.play('door')
          }
        }
      }
    } catch {}
    let mag = Math.hypot(ix, iz)
    if (mag > 1) { ix /= mag; iz /= mag; mag = 1 }

    const moving = mag > 0.08
    const running = keys.current.brake && moving
    const targetSpeed = running ? RUN_SPEED : WALK_SPEED

    const dirX = iz * sinC - ix * cosC
    const dirZ = iz * cosC + ix * sinC
    const targetX = dirX * targetSpeed * mag
    const targetZ = dirZ * targetSpeed * mag

    vel.current.x += (targetX - vel.current.x) * Math.min(1, ACCEL * dt)
    vel.current.z += (targetZ - vel.current.z) * Math.min(1, ACCEL * dt)

    const t = body.translation()

    // Simple grounded check via downward raycast
    let vy = 0
    let grounded = true
    if (world && rapier) {
      try {
        const ray = new rapier.Ray({ x: t.x, y: t.y - 0.01, z: t.z }, { x: 0, y: -1, z: 0 })
        const res = world.castRay(ray, 1.1, true)
        grounded = res && res.toi < 1.05
        try { ray.free?.() } catch {}
      } catch {}
    }

    if (grounded) {
      try { const cur = body.linvel(); vy = cur.y } catch {}
    }

    if (body && typeof body.setLinvel === 'function') {
      body.setLinvel({ x: vel.current.x, y: Math.max(-0.01, vy), z: vel.current.z }, true)
    }

    // Character yaw — faces movement direction, or camera when idle
    let moveYaw = yaw.current
    const planarSpeed = Math.hypot(vel.current.x, vel.current.z)
    if (planarSpeed > 0.4 && moving) {
      moveYaw = Math.atan2(vel.current.x, vel.current.z)
    } else if (!moving) {
      moveYaw = camYaw.current
    }
    let diff = moveYaw - yaw.current
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))
    yaw.current += diff * (1 - Math.exp(-10 * dt))

    // Update model group (position + rotation only — empty group for camera heading)
    if (modelRef.current) {
      modelRef.current.position.set(t.x, t.y + MODEL_Y, t.z)
      modelRef.current.rotation.y = yaw.current
    }

    // QA trace
    playerTrace.x = t.x
    playerTrace.y = t.y
    playerTrace.camYaw = camYaw.current
    playerTrace.t = typeof performance !== 'undefined' ? performance.now() | 0 : 0
  })

  return (
    <>
      <RigidBody
        ref={bodyRef}
        position={[spRef.current[0], SPAWN_Y, spRef.current[1]]}
        enabledRotations={[false, false, false]}
        type="dynamic"
        colliders={false}
        collisionGroups={PLAYER_COLLISION_GROUPS}
        mass={1}
        linearDamping={0.1}
        angularDamping={0}
        ccdEnabled
      >
        <CapsuleCollider args={[CAPSULE_HALF, CAPSULE_RADIUS]} friction={0.8} restitution={0} />
      </RigidBody>
      {/* The on-foot proxy group: CameraRig reads its heading, and it carries a
          plain capsule so you can SEE where you are (the real game swaps in the
          Protagonist FBX; this scene stays model-free on purpose). */}
      <group ref={modelRef}>
        <mesh position={[0, COLLIDER_CENTER_Y, 0]} castShadow>
          <capsuleGeometry args={[CAPSULE_RADIUS, CAPSULE_HALF * 2, 6, 12]} />
          <meshStandardMaterial color="#2f6fd0" roughness={0.7} />
        </mesh>
      </group>
      {/* This instance owns the chase cam for the on-foot leg (CarDriver owns
          its own while driving) — exactly one rig is ever mounted. */}
      <CameraRig bodyRef={bodyRef} modelRef={modelRef} lookHeight={1.3} yawRef={camYaw} />
      <OrbitInput />
        </>
  )
}

// Expose the rapier world for headless probes (same as App.jsx's PhysicsProbe)
const PhysicsProbe = () => {
  const { world } = useRapier()
  useEffect(() => {
    window.__gtathensPhysics = { world }
    return () => { delete window.__gtathensPhysics }
  }, [world])
  return null
}

// Plain-DOM F prompt. It lives OUTSIDE <Canvas> on purpose (an R3F child may
// never return a host element — see the "Div is not part of the THREE
// namespace" gotcha), and it mirrors the real HUD's "press F" chip so you can
// tell when the enter key will actually work. Also carries the live gamepad
// readout (event + 2 Hz poll) so the driving test scene can diagnose a dead
// controller without the main HUD mounted.
const DrivePadChip = () => {
  const [, force] = React.useReducer((x) => x + 1, 0)
  React.useEffect(() => {
    const id = setInterval(force, 500)
    window.addEventListener('gamepadconnected', force)
    window.addEventListener('gamepaddisconnected', force)
    return () => {
      clearInterval(id)
      window.removeEventListener('gamepadconnected', force)
      window.removeEventListener('gamepaddisconnected', force)
    }
  }, [])
  let label = '⌨️'
  let title = 'No gamepad'
  try {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []
    for (const p of pads) {
      if (p && p.connected) {
        label = `🎮 ${String(p.id || '').slice(0, 22)}`
        title = String(p.id || '')
        break
      }
    }
  } catch {}
  return (
    <span title={title} style={{ color: '#7dff9a', marginLeft: 12 }}>
      {label}
    </span>
  )
}

const DriveHud = () => {
  const nearCar = useGameStore((s) => s.nearCar)
  const driving = useGameStore((s) => s.driving)
  let text = ''
  if (driving === null && nearCar >= 0 && TEST_CARS[nearCar]) {
    text = `F — GET IN  ${TEST_CARS[nearCar].id}`
  } else if (driving !== null) {
    text = 'W/S accelerate · A/D steer · F exit'
  }
  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '54px',
        transform: 'translateX(-50%)',
        color: '#ffd700',
        fontFamily: "'Courier New', monospace",
        fontSize: '15px',
        fontWeight: 'bold',
        letterSpacing: '2px',
        textShadow: '1px 1px 3px rgba(0,0,0,0.9)',
        zIndex: 20,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
      <DrivePadChip />
    </div>
  )
}


// ---------------------------------------------------------------------------
// AI traffic colors for the Details overlay (mirrors TrafficCars roster order).
const AI_CAR_COLORS = ['#c0392b', '#2980b9', '#7f8c8d', '#f39c12', '#27ae60', '#8e44ad']

// ---------------------------------------------------------------------------
// AI Traffic Details overlay — `D` toggles a live readout of every AI car's
// state so the path-following / light logic can be watched in the test scene.
// Reads `carState` via the __gtathensTraffic debug seam.
const TrafficDetails = () => {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'KeyD') { e.preventDefault(); setOn((v) => !v) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!on) return null
  const rows = []
  try {
    const mod = window.__gtathensTraffic
    if (mod && mod.debug) {
      for (const r of mod.debug()) rows.push(r)
    }
  } catch { /* ignore */ }
  return (
    <div
      style={{
        position: 'fixed', left: 12, top: 64,
        color: '#00ff88', fontFamily: "'Courier New', monospace",
        fontSize: '12px', fontWeight: 'bold', lineHeight: 1.4,
        textShadow: '1px 1px 3px rgba(0,0,0,0.9)', zIndex: 20,
        background: 'rgba(0,0,0,0.55)', padding: '8px 10px', borderRadius: 4,
        pointerEvents: 'none', maxHeight: '60vh', overflowY: 'auto',
      }}
    >
      <div>🚦 TRAFFIC DETAILS (D to close)</div>
      {rows.length === 0
        ? <div>no AI cars loaded</div>
        : rows.map((r, i) => (
          <div key={i}>
            #{r.i} {r.color} lane={r.lane} spd={(r.speed).toFixed(1)}
            yaw={Math.round(r.yaw * 57.3)}° prog={r.prog.toFixed(1)}/{r.len.toFixed(0)}
                        light={r.light != null ? r.light : '—'} {r.stopped ? '⏹' : '→'}
          </div>
        ))}
    </div>
  )
}


// ---------------------------------------------------------------------------
// Main driving test scene
// ---------------------------------------------------------------------------
const DrivingScene = () => {
  const setPhase = useGameStore((s) => s.setPhase)
  const setSpawn = useGameStore((s) => s.setSpawn)
  const clearDriving = useGameStore((s) => s.clearDriving)
  const setCamView = useGameStore((s) => s.setCamView)
  const driving = useGameStore((s) => s.driving)

    const [showColliders, setShowColliders] = useState(false)

  // Car refs — stable objects, never recreated (same pattern as ParkedCars)
  const carRefs = useMemo(
    () => TEST_CARS.map(() => ({ body: { current: null }, model: { current: null } })),
    []
  )

  // Spots handed to the on-foot player (its proximity poll needs id + position).
  const spots = useMemo(
    () => TEST_CARS.map((s, i) => ({
      id: s.id,
      position: s.position,
      rotation: s.rotation,
      spotIndex: i,
    })),
    []
  )

  // Init: enter play mode so physics runs, reset state, load audio, preload models
  useEffect(() => {
    setPhase(Phase.PLAYING)
    setSpawn([0, 0])
    clearDriving()
    setCamView(1) // standard camera view
    orbit.pitchTrim = 0 // reset camera pitch from any previous session
    if (typeof window !== 'undefined') {
      window.__gtathensPlayer = playerTrace
    }
    audio.resume?.()
    TEST_CARS.forEach((s) => {
      const id = normalizeId(s.id)
      useGLTF.preload(`/models/cars/${id}.glb`)
    })
  }, [setPhase, setSpawn, clearDriving, setCamView])

  // G key: toggle collider wireframes
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'KeyG') setShowColliders((v) => !v)
    }
    window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Install the __gtathensCars QA hook (same API as ParkedCars.jsx)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const prev = window.__gtathensCars
    const hook = {
      count: () => TEST_CARS.length,
      // Which car is being driven (index) or null while on foot.
      driving: () => useGameStore.getState().driving,
      phase: () => useGameStore.getState().phase,
      loose: () => crash.loose.size,
      looseIdx: () => Array.from(crash.loose),
      damage: (i) => crash.damage[i] ?? 0,
      pos: (i) => {
        const rb = crash.bodies[i]
        if (!rb || typeof rb.translation !== 'function') return null
        const t = rb.translation()
        return { x: t.x, y: t.y, z: t.z }
      },
      spot: (i) => {
        const s = TEST_CARS[i]
        if (!s) return null
        const lp = crash.livePos[i]
        return {
          id: s.id,
          x: lp ? lp.x : s.position[0],
          z: lp ? lp.z : s.position[2],
          rot: s.rotation,
        }
      },
      btype: (i) => {
        const rb = crash.bodies[i]
        if (!rb || typeof rb.bodyType !== 'function') return null
        try { return rb.bodyType() } catch { return null }
      },
      roadSegs: () => (typeof window !== 'undefined' ? (window.__gtathensRoadCache?.segs?.length ?? 0) : 0),
      traffic: () => crash.aiLive.filter((l) => l && Number.isFinite(l.x)).length,
      asphalt: () => true,
      ram: (i) => {
        const d = useGameStore.getState().driving
        const mine = d != null ? crash.bodies[d] : null
        if (!mine) return null
        const s = TEST_CARS[i]
        if (!s) return null
        const lp = crash.livePos[i] || { x: s.position[0], z: s.position[2] }
        const hx = Math.sin(s.rotation)
        const hz = Math.cos(s.rotation)
        const t = mine.translation()
        mine.setTranslation({ x: lp.x - hx * 6.5, y: t.y, z: lp.z - hz * 6.5 }, true)
        mine.setLinvel({ x: 0, y: 0, z: 0 }, true)
        mine.setAngvel({ x: 0, y: 0, z: 0 }, true)
        const c = Math.cos(s.rotation / 2)
        const sn = Math.sin(s.rotation / 2)
        mine.setRotation({ x: 0, y: sn, z: 0, w: c }, true)
        return { target: i, x: lp.x - hx * 6.5, z: lp.z - hz * 6.5 }
      },
    }
        window.__gtathensCars = hook
    return () => {
      if (window.__gtathensCars === hook) window.__gtathensCars = prev
    }
  }, [])

  // Traffic QA seam: live car states + a debug snapshot for TrafficDetails.
  // Single writer (this effect); cleared on unmount per the "reuse, don't
  // replace" rule for window seams.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const prev = window.__gtathensTraffic
    const cur = window.__gtathensTraffic
    window.__gtathensTraffic = {
      trafficCount: () => crash.aiLive.filter((l) => l && Number.isFinite(l.x)).length,
      car: (i) => {
        const st = getCarState(i)
        const live = crash.aiLive[i]
        return live && Number.isFinite(live.x) ? { x: live.x, z: live.z } : null
      },
      lights: () => {
        // Live lights array written by TrafficCars after map load.
        // TrafficLights DOM overlay reads from here (ignores its `lights` prop).
        try { return window.__gtathensTrafficLights ? window.__gtathensTrafficLights.slice() : [] } catch { return [] }
      },
      debug: () => {
        const out = []
        for (let i = 0; i < crash.aiLive.length; i += 1) {
          const live = crash.aiLive[i]
          if (!live || !Number.isFinite(live.x)) continue
          const st = getCarState(i)
          if (!st) continue
          const r = window.__gtathensTrafficRoutes && window.__gtathensTrafficRoutes[i]
          out.push({
            i,
            color: AI_CAR_COLORS[i % AI_CAR_COLORS.length],
            lane: st.lane,
            speed: st.speed || 0,
            yaw: st.yaw || 0,
            prog: st.progress || 0,
            len: r ? r.totalLen : 0,
            light: st.whichLight,
            stopped: !!st.stopped,
          })
        }
        return out
      },
    }
    return () => { if (window.__gtathensTraffic === prev) window.__gtathensTraffic = prev }
  }, [])

  return (
    <>
      <DriveHud />
      <TrafficDetails />
      <Canvas dpr={[1, 1.75]} shadows camera={{ position: [0, 6, 14], fov: 68, near: 0.5, far: 500 }}>
      {/* Sky + lighting. Without these, meshStandardMaterial renders pure black
          (no lights = no shading) and the scene reads as a black screen. */}
      <color attach="background" args={['#cfe8f7']} />
      <ambientLight intensity={0.95} />
      <hemisphereLight args={['#cfe8f7', '#6b7a52', 0.7]} />
      <directionalLight
        position={[30, 50, 20]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-near={1}
        shadow-camera-far={200}
        shadow-bias={-0.0002}
        shadow-normalBias={0.04}
      />

      <Physics gravity={[0, -9.81, 0]} debug={showColliders}>
        <PhysicsProbe />

        {/* Simple ground plane — sized to the FULL map area (~440 m OSM tile),
            so AI traffic looping the road graph never rolls off the physics
            floor at the edges (a 200 m plane ended mid-network). */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
          <planeGeometry args={[480, 480]} />
          <meshStandardMaterial color="#7d8570" />
        </mesh>
        <RigidBody type="fixed" position={[0, -0.01, 0]} colliders={false} canSleep={false} collisionGroups={0x0001 | (0x000f << 16)}>
          <CuboidCollider args={[240, 0.01, 240]} position={[0, 0, 0]} friction={0.8} restitution={0} />
        </RigidBody>

        {/* Real OSM roads (visual ribbons + the isOnAsphalt segment cache).
            Loaded from the same map_data.json the main game uses. */}
        <TestRoads />

        {/* AI traffic looping the OSM road graph (same RoadPathfinder routes
            as the main game's Npcs.jsx). Mounts once map data is loaded. */}
        <TrafficCars />

        {/* Test cars */}
        {TEST_CARS.map((s, i) => (
          <Car
            key={i}
            id={s.id}
            position={s.position}
            rotation={s.rotation}
            dynamic={driving === i}
            spotIndex={i}
            bodyRef={carRefs[i].body}
            modelRef={carRefs[i].model}
          />
        ))}

        <LooseSettler />

        {/* Driven car controller */}
        {driving != null && driving < TEST_CARS.length && (
          <CarDriver
            bodyRef={carRefs[driving].body}
            modelRef={carRefs[driving].model}
            spotIndex={driving}
            half={HALF[normalizeId(TEST_CARS[driving].id)]}
            carId={TEST_CARS[driving].id}
          />
        )}

        {/* On-foot player — only when not driving. It owns its body refs and
            its own CameraRig, so nothing from a previous session can leak. */}
        {driving === null && <DriveTestPlayer spots={spots} />}
      </Physics>
      </Canvas>
    </>
  )
}

export default DrivingScene




