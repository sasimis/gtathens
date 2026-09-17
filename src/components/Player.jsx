import React, { useEffect, useRef } from 'react'
import { RigidBody, CapsuleCollider, useRapier } from '@react-three/rapier'
import { useFrame } from '@react-three/fiber'
import { useKeyboardControls, KeyboardControls } from '@react-three/drei'
import * as THREE from 'three'
import useGameStore, { Phase } from '../store/useGameStore'
import Protagonist, { CHARACTERS } from './Protagonist'
import { CAR_LIVE_POS, PARK_COUNT, PARK_RADIUS, PLAYER_COLLISION_GROUPS, useParkingSpots, isOnAsphalt } from './Car'
import { CameraRig, OrbitInput } from './FollowCamera'
import { BTN, getGamepad, padEdge, padHeld, readStick } from '../lib/gamepad'
import { audio } from '../lib/audio'
import WeaponController from './WeaponController'
import { BulletFx } from './BulletFx'

// How close (m) the on-foot player must be to a car before F will enter it.
// Slightly generous + hysteresis (see CarEntrance): once a prompt is showing
// we keep showing it to its car until the player walks clearly away, so the
// F hint never flickers at the boundary and re-entry always works.
const ENTER_RANGE_SQ = 3.4 * 3.4
// Hysteresis: while a prompt is already shown we keep it until the player
// is clearly away (> +0.8 m), so the hint never flickers at the edge and
// hopping back into the same car always works.
const ENTER_EXIT_RANGE_SQ = 4.2 * 4.2

// Keyboard map for drei's KeyboardControls context
const KEYBOARD_MAP = [
  { name: 'forward', keys: ['ArrowUp', 'KeyW'] },
  { name: 'backward', keys: ['ArrowDown', 'KeyS'] },
  { name: 'leftward', keys: ['ArrowLeft', 'KeyA'] },
  { name: 'rightward', keys: ['ArrowRight', 'KeyD'] },
  { name: 'jump', keys: ['Space'] },
  { name: 'run', keys: ['ShiftLeft', 'ShiftRight'] },
  { name: 'fire', keys: ['KeyX'] },
  { name: 'reload', keys: ['KeyR'] },
  { name: 'cycleNext', keys: ['KeyE'] },
  { name: 'cyclePrev', keys: ['KeyQ'] },
  { name: 'inventory', keys: ['KeyI'] },
]

// Movement constants
const WALK_SPEED = 3.2
const RUN_SPEED = 6.6
const ACCEL = 16
const DAMPING = 10
const JUMP_V = 7.5
// Rapier capsule: total height = halfHeight*2 + radius*2 = 0.6*2 + 0.35*2 = 1.9 m.
// Character model is 1.8 m tall with feet at local y=0.
const CAPSULE_HALF = 0.6
const CAPSULE_RADIUS = 0.35
const COLLIDER_CENTER_Y = CAPSULE_HALF + CAPSULE_RADIUS // 0.95 — body origin rests here
const FLOAT_HEIGHT = 0.02 // tiny clearance so feet sit on y=0, never inside it
const SPAWN_Y = COLLIDER_CENTER_Y + 0.3 // small drop so it lands cleanly on the ground
const MODEL_Y = -COLLIDER_CENTER_Y // model feet (local 0) land at collider bottom
// Model faces +Z by default (verified visually: with a PI offset he
// moonwalked — moving forward while facing backwards). No offset needed:
// the model's forward (+Z) already matches the movement yaw basis.
const CHARACTER_FACING_OFFSET = 0

// Old local deadzone helper removed — shared lib/gamepad.js now owns this.
// (applyDeadzone + getGamepad + BTN constants are imported above.)

/**
 * Watches the player's distance to every parked car and writes the nearest
 * reachable one into the store (the HUD "F to enter" hint). Pressing F while
 * a car is in reach climbs in: `driving` is set, and this component is torn
 * down together with the on-foot <Player>.
 */
// QA trace for scripts/smoke.mjs: ONE stable object rewritten every frame
// (numbers only, zero allocation) so a headless test can measure where the
// player is relative to the camera. A frozen trace + a missing
// `window.__gtathensCar` is how the test detects the on-foot <Player>
// unmounting (i.e. driving).
const playerTrace = { x: 0, y: 0, z: 0, camYaw: 0, t: 0 }
if (typeof window !== 'undefined') window.__gtathensPlayer = playerTrace

const CarEntrance = ({ bodyRef, spots }) => {
  const phase = useGameStore((s) => s.phase)
  const setNearCar = useGameStore((s) => s.setNearCar)
  const setDriving = useGameStore((s) => s.setDriving)
  const driving = useGameStore((s) => s.driving)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const drivingRef = useRef(driving)
  drivingRef.current = driving
  const nearRef = useRef(-1)
  // Grace period: this component (re)mounts the instant a car is entered or
  // exited — i.e. DURING the very F keydown that caused it. Without a guard,
  // the same keydown also reaches the freshly attached listener on the other
  // side (CarDriver's exit handler), so one press could enter AND exit —
  // F appeared to "do nothing" half the time, depending on whether the
  // remount won the race with the event dispatch. Same guard lives in
  // CarDriver for the mirrored direction.
  const mountedAt = useRef(performance.now())
  const pos = useRef(new THREE.Vector3())

  useEffect(() => {
    // Poll every frame-ish (100 ms): distance to every parked/traffic car.
    // Hysteresis keeps the current prompt pinned to its car until the player
    // walks clearly away, and driving cars are skipped only while one is
    // actually being driven — a parked-again car is enterable immediately.
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
      // Distance to a car uses its LIVE position when it has been driven away
      // from its parking spot (CAR_LIVE_POS), otherwise the spot origin.
      // Without this the car you had just exited was undetectable — F did
      // nothing because detection still measured against the ORIGINAL
      // parking-spot coordinates.
      const spotX = (i) => {
        const lp = CAR_LIVE_POS[i]
        return lp ? lp.x : spots[i].position[0]
      }
      const spotZ = (i) => {
        const lp = CAR_LIVE_POS[i]
        return lp ? lp.z : spots[i].position[2]
      }
      // Keep the current car while still within the wider exit radius.
      if (nearRef.current >= 0 && nearRef.current < spots.length) {
        const dx = pos.current.x - spotX(nearRef.current)
        const dz = pos.current.z - spotZ(nearRef.current)
        if (dx * dx + dz * dz < ENTER_EXIT_RANGE_SQ) return
      }
      let best = -1
      let bestD = ENTER_RANGE_SQ
      for (let i = 0; i < spots.length; i++) {
        const dx = pos.current.x - spotX(i)
        const dz = pos.current.z - spotZ(i)
        const d = dx * dx + dz * dz
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best !== nearRef.current) {
        nearRef.current = best
        setNearCar(best)
      }
    }, 100)
    return () => {
      clearInterval(timer)
      nearRef.current = -1
      setNearCar(-1)
    }
  }, [bodyRef, spots, setNearCar])

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'KeyF' || e.repeat) return
      if (phaseRef.current !== Phase.PLAYING) return
      if (drivingRef.current !== null) return
      if (performance.now() - mountedAt.current < 350) return
      if (nearRef.current < 0) return
      // Jump straight in — spots are stable module-level indices shared with
      // ParkedCars, so re-entering the same car (or any nearby car) always
      // resolves to a live car body.
      setDriving(nearRef.current)
      audio.play('door')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setDriving])

  // QA hook (scripts/smoke.mjs): teleport the player body next to a parking
  // spot so the headless test can exercise the REAL F-key enter path (same
  // window listener above) instead of poking the store directly.
  useEffect(() => {
    window.__gtathensCar = {
      count: spots.length,
      near: () => nearRef.current,
      spot: (i) => {
        const s = spots[i]
        return s ? { x: s.position[0], z: s.position[2] } : null
      },
      state: () => {
        const st = useGameStore.getState()
        return {
          driving: st.driving,
          nearCar: st.nearCar,
          respawn: st.respawn ? { x: st.respawn.x, z: st.respawn.z } : null,
        }
      },
      tp: (idx = 0) => {
        const body = bodyRef.current
        if (!body || typeof body.setTranslation !== 'function') return 'no body'
        const i = ((idx % spots.length) + spots.length) % spots.length
        const s = spots[i]
        body.setTranslation(
          { x: s.position[0] + 2.2, y: COLLIDER_CENTER_Y + FLOAT_HEIGHT, z: s.position[2] },
          true,
        )
        body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        return i
      },
    }
    return () => { delete window.__gtathensCar }
  }, [bodyRef, spots])

  // Gamepad: X (or LT) enters the nearby car — edge-triggered so holding
  // the button never double-fires. The mount grace period applies here too
  // (see the F-key handler above).
  useFrame(() => {
    const pad = getGamepad()
    if (!pad) return
    if (phaseRef.current !== Phase.PLAYING) return
    if (drivingRef.current !== null) return
    if (performance.now() - mountedAt.current < 350) return
    if (nearRef.current < 0) return
    if (padEdge(pad, BTN.X) || padEdge(pad, BTN.LT)) {
      setDriving(nearRef.current)
    }
  })

  return null
}

const PlayerBody = ({ spawn }) => {
  const bodyRef = useRef(null)
  const modelRef = useRef(null)

  const [, getKeys] = useKeyboardControls()
  const { world, rapier } = useRapier()

  const vel = useRef(new THREE.Vector3())
  const stepT = useRef(0) // footstep accumulator (see useFrame below)
  // Initialize yaw from respawn if exiting a car (face same direction as car)
  const respawn = useGameStore((s) => s.respawn)
  const initialYaw = respawn?.yaw ?? Math.PI
  const yaw = useRef(initialYaw)
  const camYaw = useRef(initialYaw) // character always faces camera direction

  const [action, setAction] = React.useState('idle')
  const [animSpeed, setAnimSpeed] = React.useState(1)

  const character = useGameStore((s) => s.character)
  const clearRespawn = useGameStore((s) => s.clearRespawn)
  const cycleCharacter = useGameStore((s) => s.cycleCharacter)

  const rp = respawn
  // Freeze the mount position ONCE. `respawn` is cleared right after mount
  // (effect below), and <RigidBody> APPLIES its `position` prop whenever it
  // changes — if `sp` flipped back to the map spawn once the respawn was
  // consumed, the freshly-spawned body TELEPORTED there. That is how the
  // character ended up stranded at the map spawn, 12+ m from the car it had
  // just exited ("character separated from the car", F prompt never showing).
  const spRef = useRef(null)
  if (spRef.current === null) {
    spRef.current = rp ? [rp.x, rp.z] : (spawn ?? [0, 0])
  }
  const sp = spRef.current
  const char = CHARACTERS[Math.abs(character) % CHARACTERS.length] ?? CHARACTERS[0]
  // The parking layout MUST be keyed on the MAP spawn — the exact anchor
  // <ParkedCars> uses — never on the post-exit respawn point. Spots are
  // sorted/filtered relative to their anchor, so keying on `sp` produced a
  // DIFFERENT list than the world rendered: `nearCar` indices pointed at the
  // wrong cars (F did nothing, or "entered" a car on the other side of the
  // map and the character looked separated from it). Same key => the shared
  // module cache hands both sides the SAME array (and skips the refetch, so
  // re-entering works on the very first 100 ms tick after an exit).
  const spots = useParkingSpots(spawn ?? [0, 0], PARK_COUNT, PARK_RADIUS)

  // Clear respawn after mount
  useEffect(() => {
    if (respawn) clearRespawn()
  }, [respawn, clearRespawn])

  // QA seam (scripts/smoke.mjs): generic teleport for the NPC shoot test.
  // Places the capsule anywhere and points the free-look yaw at a target, so
  // the chase camera — and therefore the aim ray fired by WeaponController —
  // faces it. Mirrors __gtathensCar.tp() (which is car-index based) but works
  // for arbitrary world coordinates. Never called by game code.
  useEffect(() => {
    window.__gtathensTp = (x, z, facingYaw = null) => {
      const body = bodyRef.current
      if (!body || typeof body.setTranslation !== 'function') return 'no body'
      body.setTranslation({ x, y: COLLIDER_CENTER_Y + FLOAT_HEIGHT, z }, true)
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      // yaw + camYaw must move together: the model faces camYaw and the rig
      // takes its view direction from the same value (see the yawRef note at
      // the bottom of this file).
      if (Number.isFinite(facingYaw)) {
        camYaw.current = facingYaw
        yaw.current = facingYaw
      }
      return { x, z }
    }
    return () => { delete window.__gtathensTp }
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      // P cycles the playable character. (Tab used to do this, but Tab now
      // toggles the inventory — see ui/Inventory.jsx.)
      if (e.code === 'KeyP' && !e.repeat) {
        cycleCharacter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycleCharacter])

  // Mouse drag rotates the view horizontally (and the character with it).
  // OrbitInput in FollowCamera handles pitch + zoom; this handles yaw.
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

  useFrame(({ camera }, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05)
    const keys = getKeys()
    const body = bodyRef.current

    // --- Gamepad (left stick move, right stick look, A jump, Y switch) ---
    const pad = getGamepad()
    let gpx = 0,
      gpz = 0
    let gpLookX = 0
    let gpJump = false
    let gpRun = false
    if (pad) {
      gpx = readStick(pad, 0) // left stick X: strafe
      gpz = -readStick(pad, 1) // left stick Y (up = +forward)
      gpLookX = readStick(pad, 2) // right stick X: turn camera/character
      gpJump = padEdge(pad, BTN.A)
      gpRun = padHeld(pad, BTN.LB) || padHeld(pad, BTN.RB)
      // Right stick steers the chase camera horizontally.
      if (Math.abs(gpLookX) > 0.001) {
        camYaw.current -= gpLookX * 2.4 * dt
      }
      if (padEdge(pad, BTN.Y)) cycleCharacter()
    }

    // --- Input: W = forward, S = back, A/D = strafe + lean-turn ---
    // (Previous build had iz negated, which made S walk forward. Fixed:
    // +iz is camera-forward, so W walks away from the camera.)
    let ix = (keys.rightward ? 1 : 0) - (keys.leftward ? 1 : 0) + gpx
    let iz = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0) + gpz
    const rawStrafe = (keys.rightward ? 1 : 0) - (keys.leftward ? 1 : 0) + gpx
    // Normalize ONLY when the combined input exceeds full deflection (e.g.
    // keyboard W+D diagonal = sqrt(2)). Dividing unconditionally by
    // min(1, len) left diagonals 41% too fast; analog magnitude is kept so
    // half-tilt stick = half speed.
    let mag = Math.hypot(ix, iz)
    if (mag > 1) {
      ix /= mag
      iz /= mag
      mag = 1
    }
    const moving = mag > 0.08
    const strafing = Math.max(-1, Math.min(1, rawStrafe))

    // --- Camera-relative movement ---
    // camYaw points AWAY from the camera (facing direction). W (iz=+1)
    // walks away from the camera, A strafes left relative to the view.
    const sinC = Math.sin(camYaw.current)
    const cosC = Math.cos(camYaw.current)
    // Right-handed camera basis: forward = (sinC, cosC) and
    // right = forward × up = (-cosC, +sinC). The previous build used
    // (+cosC, -sinC) for the strafe axis — that is the LEFT vector, so A/D
    // (and the left stick) moved mirrored. ix now follows the true right.
    const dirX = iz * sinC - ix * cosC
    const dirZ = iz * cosC + ix * sinC

    // --- Acceleration & damping ---
    const running = (keys.run || gpRun) && moving
    const targetSpeed = running ? RUN_SPEED : WALK_SPEED
    const targetX = dirX * targetSpeed * mag
    const targetZ = dirZ * targetSpeed * mag

    vel.current.x += (targetX - vel.current.x) * Math.min(1, ACCEL * dt)
    vel.current.z += (targetZ - vel.current.z) * Math.min(1, ACCEL * dt)
    if (!moving) {
      const damp = Math.exp(-DAMPING * dt)
      vel.current.x *= damp
      vel.current.z *= damp
    }

    // --- Read physics state ---
    let bodyPos = { x: sp[0], y: SPAWN_Y, z: sp[1] }
    let currentVel = { x: 0, y: 0, z: 0 }
    if (body && typeof body.translation === 'function') {
      bodyPos = body.translation()
    }
    if (body && typeof body.linvel === 'function') {
      currentVel = body.linvel()
    }

    // Anti-sink safety net: if the body ever drops below the ground plane
    // (e.g. spawned inside the road ribbon or a collider pop), lift it back
    // to resting height instead of letting the player fall through the city.
    const restY = COLLIDER_CENTER_Y + FLOAT_HEIGHT
    if (bodyPos.y < COLLIDER_CENTER_Y - 0.2) {
      body.setTranslation({ x: bodyPos.x, y: restY, z: bodyPos.z }, true)
      bodyPos = { x: bodyPos.x, y: restY, z: bodyPos.z }
      if (typeof body.setLinvel === 'function') {
        const lv = body.linvel()
        body.setLinvel({ x: lv.x, y: Math.max(0, lv.y), z: lv.z }, true)
        currentVel = { x: lv.x, y: Math.max(0, lv.y), z: lv.z }
      }
    }

      // Grounded: body origin sits at COLLIDER_CENTER_Y when standing on y=0.
      const grounded = bodyPos.y <= restY + 0.15 && currentVel.y <= 0.6

    // Jump (keyboard Space or gamepad A, edge-triggered above)
    let vy = currentVel.y
    if (grounded && (keys.jump || gpJump)) {
      vy = JUMP_V
    }

    // Apply velocity: X/Z from our movement, Y from physics (gravity + contacts)
    if (body && typeof body.setLinvel === 'function') {
      body.setLinvel({ x: vel.current.x, y: vy, z: vel.current.z }, true)
    }

    // --- Facing: GTA-style — run toward the move direction, strafe leans ---
    // W/S run straight; A/D strafing turns the body a touch (up to ~35 deg)
    // toward the strafe side so left/right taps are readable.
    let moveYaw = yaw.current
    const planarSpeed = Math.hypot(vel.current.x, vel.current.z)
    if (planarSpeed > 0.4 && moving) {
      moveYaw = Math.atan2(vel.current.x, vel.current.z)
      // Lean into pure strafes: when moving sideways (little forward input),
      // bias the facing a bit more toward the strafe.
      const sideBias = strafing * (1 - Math.min(1, Math.abs(iz))) * 0.55
      moveYaw += sideBias
    } else if (!moving) {
      moveYaw = camYaw.current
    }
    let diff = moveYaw - yaw.current
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))
    yaw.current += diff * (1 - Math.exp(-10 * dt))

    // --- Footsteps (surface-aware: asphalt cracks, grass thuds) -----------
    // Timer accumulates while actually planar-moving; step interval shortens
    // when running. Grounded only: falling shouldn't patter. The asphalt
    // check is the throttled module cache (no raycast in the hot path).
    if (moving && planarSpeed > 0.6) {
      stepT.current += dt * (planarSpeed / WALK_SPEED)
      const interval = running ? 0.42 : 0.58
      if (stepT.current >= interval) {
        stepT.current = 0
        let onRoad = true
        try { onRoad = isOnAsphalt(bodyPos.x, bodyPos.z) } catch { /* assume asphalt */ }
        audio.stepSurface(onRoad)
      }
    } else {
      stepT.current = 0
    }

    // --- Update model transform ---
    if (modelRef.current) {
      modelRef.current.position.set(bodyPos.x, bodyPos.y + MODEL_Y, bodyPos.z)
      // Model faces +Z; its forward already matches the movement yaw basis.
      modelRef.current.rotation.y = yaw.current + CHARACTER_FACING_OFFSET
    }

    // --- Animation ---
    let next = 'idle'
    let speedMult = 1
    if (!grounded || vy > 2.0) {
      next = 'jump'
      speedMult = 1.1
    } else if (moving) {
      next = 'run'
      speedMult = running ? 1.4 : 0.75
    }
    setAction((prev) => (prev !== next ? next : prev))
    setAnimSpeed((prev) => (prev !== speedMult ? speedMult : prev))

    // QA trace: stable object, number writes only (no per-frame allocation).
    playerTrace.x = bodyPos.x
    playerTrace.y = bodyPos.y
    playerTrace.z = bodyPos.z
    playerTrace.camYaw = camYaw.current
    playerTrace.t = performance.now() | 0
  })

    return (
    <>
      <RigidBody
        ref={bodyRef}
        position={[sp[0], SPAWN_Y, sp[1]]}
        enabledRotations={[false, false, false]}
        type="dynamic"
        colliders={false}
        collisionGroups={PLAYER_COLLISION_GROUPS}
        mass={1}
        linearDamping={0.1}
        angularDamping={0}
        ccdEnabled
      >
        {/* True capsule: halfHeight matches the 1.8 m model, rounded ends
            glide instead of catching on the ground -> no more sinking. */}
        <CapsuleCollider
          args={[CAPSULE_HALF, CAPSULE_RADIUS]}
          friction={0.8}
          restitution={0}
        />
      </RigidBody>
      <group ref={modelRef}>
        <Protagonist action={action} skin={char.skin} animSpeed={animSpeed} />
        <WeaponController bodyRef={bodyRef} modelRef={modelRef} camYaw={camYaw} />
      </group>
      <CarEntrance bodyRef={bodyRef} spots={spots} />
      <BulletFx />
      {/* Shared follow camera — same smooth behavior as driving */}
      {/* yawRef={camYaw} is REQUIRED on foot. The rig must follow the free
          orbit yaw — the exact basis the movement code uses (W forward,
          A/D strafe on the true right vector) — instead of the model group's
          +Z, so the camera parks BEHIND the character and never flips 180
          degrees when the move direction reverses. The car passes no yawRef
          because its model +Z really is the nose. */}
      <CameraRig bodyRef={bodyRef} modelRef={modelRef} lookHeight={1.3} yawRef={camYaw} />
      <OrbitInput />
    </>
  )
}

const Player = () => {
  const spawn = useGameStore((s) => s.spawn)
  const sp = spawn ?? [0, 0]
  return (
    <KeyboardControls map={KEYBOARD_MAP}>
      <PlayerBody spawn={sp} />
    </KeyboardControls>
  )
}

// Keep Space from scrolling the page
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (['Space'].includes(e.code)) e.preventDefault()
    },
    { passive: false },
  )
}

export default Player