
import { useCallback, useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import * as THREE from 'three'
import useGameStore, { Phase } from '../../store/useGameStore'
import { CameraRig, OrbitInput, driveOrbit, nudgePitchTrim, DRIVE_YAW_MAX } from '../FollowCamera'
import { BTN, getDrivePad, padEdge, padHeld, padValue, readDriveAxis, readStick, wheelPedals, isWheelLike, vibrateGamepad, GP_DEADZONE_DRIVE } from '../../lib/gamepad'
import { CAR_MAX_SPEED, CAR_REVERSE_MAX, CAR_TURN_RATE, LOOSE_MAX_MS, NITRO_SPEED_MUL, NITRO_ACCEL_MUL, FOV_SPEED_ADD, FOV_NITRO_ADD, getCarTuning } from './constants.js'
import { crash, isOnAsphalt, aiDamage, setAiCarOccupied, setRigidBodyType } from './crashManager.js'
import { combat } from '../../lib/combat'
import { setAnimSpot } from './carVisuals.js'
import { audio } from '../../lib/audio'

const q = new THREE.Quaternion()
const fwd = new THREE.Vector3()
const right = new THREE.Vector3()
const up = new THREE.Vector3(0, 1, 0)

const KEY_MAP = {
  KeyW: 'fwd', ArrowUp: 'fwd',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'brake',
  ShiftLeft: 'nitro', ShiftRight: 'nitro',
  KeyH: 'horn',
}

export const CarDriver = ({ bodyRef, modelRef, spotIndex = null, half = null, aiIndex = null, carId = null }) => {
  const phase = useGameStore((s) => s.phase)
  const setCarDamage = useGameStore((s) => s.setCarDamage)
  const { world, rapier } = useRapier()
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const mountedAt = useRef(typeof performance !== 'undefined' ? performance.now() : 0)
  const keys = useRef({ fwd: false, back: false, left: false, right: false, brake: false, nitro: false, horn: false })
  const dmgSync = useRef({ idx: null, val: 0 })
  const boomRef = useRef(false) // one-shot guard: damage hit 100% while driving
  const steerRef = useRef(0)
  const hornAt = useRef(0)
  const fovCur = useRef(null)

  const exitCar = useCallback(() => {
    const store = useGameStore.getState()
    const rb = bodyRef.current
    if (!rb?.translation || store.phase !== Phase.PLAYING) return
    const t = rb.translation()
    const rot = rb.rotation()
    q.set(rot.x, rot.y, rot.z, rot.w)
    fwd.set(0, 0, 1).applyQuaternion(q)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1)
    fwd.normalize()
    right.crossVectors(fwd, up).normalize()

    const candidates = [
      { dx: right.x, dz: right.z, d: 2.6 },
      { dx: -right.x, dz: -right.z, d: 2.6 },
      { dx: right.x, dz: right.z, d: 4.0 },
      { dx: -right.x, dz: -right.z, d: 4.0 },
      { dx: -fwd.x, dz: -fwd.z, d: 4.6 },
      { dx: fwd.x, dz: fwd.z, d: 5.4 },
    ]
    const halfW = half ? half[0] : 1.4
    const halfL = half ? half[2] : 2.6
    let out = candidates[0]

    if (world && rapier) {
      for (const c of candidates) {
        const alongR = Math.abs(c.dx * right.x + c.dz * right.z)
        const alongF = Math.abs(c.dx * fwd.x + c.dz * fwd.z)
        const start = alongR * halfW + alongF * halfL + 0.1
        const len = c.d - start
        if (len < 0.3) continue
        let ray = null
        try {
          ray = new rapier.Ray(
            { x: t.x + c.dx * start, y: t.y + 0.95, z: t.z + c.dz * start },
            { x: c.dx, y: 0, z: c.dz }
          )
        } catch { ray = null }
        let blocked = true
        if (ray) {
          try { blocked = !!world.castRay(ray, len, true) } catch { blocked = true }
          try { ray.free?.() } catch {}
        }
        if (!blocked) { out = c; break }
      }
    }

    if (modelRef?.current) {
      modelRef.current.rotation.x = 0
      modelRef.current.rotation.z = 0
    }
    if (spotIndex != null && spotIndex >= 0) crash.setLive(spotIndex, t.x, t.z)
    if (aiIndex != null && aiIndex >= 0 && typeof crash.setAiLive === 'function') crash.setAiLive(aiIndex, t.x, t.z)
    store.setRespawn({
      x: t.x + out.dx * out.d,
      z: t.z + out.dz * out.d,
      yaw: Math.atan2(fwd.x, fwd.z),
    })
    if (aiIndex != null && aiIndex >= 0) {
      setAiCarOccupied(aiIndex, false)
      try { store.clearDrivingAi() } catch (e) { /* older store */ }
    }
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
    Object.keys(keys.current).forEach((k) => (keys.current[k] = false))
    audio.play('door')
    store.clearDriving()
  }, [bodyRef, half, spotIndex, aiIndex, world, rapier])

  useFrame((frameState, delta) => {
    const rb = bodyRef.current
    if (!rb?.linvel) return
    const tNow = rb.translation()
    if (spotIndex != null && spotIndex >= 0) crash.setLive(spotIndex, tNow.x, tNow.z)
    if (aiIndex != null && aiIndex >= 0 && typeof crash.setAiLive === 'function') crash.setAiLive(aiIndex, tNow.x, tNow.z)

    const dmg = aiIndex != null && aiIndex >= 0
      ? aiDamage(aiIndex)
      : spotIndex != null ? Math.min(1, crash.damage[spotIndex] ?? 0) : 0
    // Sync key covers BOTH systems: parked index or ai<i>. Without the ai part,
    // two stolen cars with equal damage would skip the HUD resync on switch.
    // NOTE: pad is read below, so the rumble uses a fresh getDrivePad() here.
    const syncIdx = spotIndex != null ? spotIndex : aiIndex != null && aiIndex >= 0 ? `ai${aiIndex}` : null
    if (syncIdx !== dmgSync.current.idx || Math.abs(dmg - dmgSync.current.val) > 0.001) {
      const prev = dmgSync.current.val
      dmgSync.current = { idx: syncIdx, val: dmg }
      setCarDamage(dmg)
      // Crash rumble: a damage JUMP means we just hit something hard.
      try {
        if (dmg - prev > 0.02) {
          const rp = getDrivePad()
          if (rp) vibrateGamepad(rp, 220, 0.9, 1.0)
        }
      } catch {}
    }

    // --- Vehicle destroyed (damage hit 100%): eject the occupant ---------
    // The explosion FX already fired from addDamage's threshold crossing;
    // here the OCCUPANT reacts: the normal ray-cleared exitCar handoff, HP
    // loss, rumble + camera shake. boomRef makes it once per mount (and
    // CarEntrance blocks re-entering the wreck anyway).
    if (dmg >= 1 && !boomRef.current && phaseRef.current === Phase.PLAYING) {
      boomRef.current = true
      try {
        const gs = useGameStore.getState()
        gs.setHealth(Math.max(0, (gs.health ?? 100) - 45))
        if (typeof gs.pushToast === 'function') gs.pushToast('Vehicle destroyed!', 'health')
      } catch { /* store without the action */ }
      try {
        const rp = getDrivePad()
        if (rp) vibrateGamepad(rp, 640, 1, 1.2)
      } catch { /* no pad */ }
      try { combat.shake = Math.max(combat.shake || 0, 0.5) } catch { /* no combat */ }
      driveOrbit.yaw = 0 // hand a clean camera back to the on-foot rig
      exitCar()
    }

    if (phaseRef.current !== Phase.PLAYING) {
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
      return
    }

      const pad = getDrivePad()
    let gpF = 0, gpB = 0, gpS = 0, gpBr = false, gpNitro = false, gpHornEdge = false
    let padIsWheel = false
    if (pad) {
      padIsWheel = isWheelLike(pad)
      // Pedals: RT/LT triggers always. The raw-axes pedal fallback (old
      // wheelPedals path) is ONLY for real wheels — on a standard gamepad it
      // read LS-Y / RS-X as gas+brake, so touching the right stick (camera)
      // made the car drive itself.
      const ped = padIsWheel
        ? wheelPedals(pad)
        : { gas: padValue(pad, BTN.RT), brake: padValue(pad, BTN.LT) }
      gpF = ped.gas
      gpB = ped.brake
      try {
        if (gpF < 0.15 && padHeld(pad, BTN.A)) gpF = 1
        if (gpB < 0.15 && padHeld(pad, BTN.X)) gpB = 1
      } catch {}
      // Steering: LS X (wheels use their own axis curve below). The old RS-X
      // fallback is gone — the right stick is CAMERA-ONLY while driving.
      gpS = readDriveAxis(pad, 0)
      try {
        if (Math.abs(gpS) < 0.05) {
          const dl = padHeld(pad, BTN.DPAD_LEFT) ? -1 : 0
          const dr = padHeld(pad, BTN.DPAD_RIGHT) ? 1 : 0
          if (dl || dr) gpS = dl + dr
        }
      } catch {}
      if (padIsWheel) {
        try {
          const wS = readDriveAxis(pad, 0, 0.03, 1.3)
          if (Math.abs(wS) > Math.abs(gpS)) gpS = wS
        } catch {}
      }
      // Right stick = camera only (independent orbit): RS-X yaws the chase
      // camera around the car, RS-Y nudges pitch trim. Never touches pedals
      // or steering.
      try {
        const lookX = readStick(pad, 2)
        const lookY = readStick(pad, 3)
        if (Math.abs(lookX) > 0.05) {
          driveOrbit.yaw = Math.max(-DRIVE_YAW_MAX, Math.min(DRIVE_YAW_MAX, driveOrbit.yaw - lookX * 2.6 * delta))
        } else {
          driveOrbit.yaw *= Math.exp(-2.5 * delta) // gentle re-center behind the car
        }
        if (Math.abs(lookY) > 0.05) nudgePitchTrim(lookY * 1.1 * delta)
      } catch {}
      gpBr = padHeld(pad, BTN.A)
      // Nitro: X / LB on pad, any spare wheel button as fallback.
      gpNitro = padHeld(pad, BTN.X) || padHeld(pad, BTN.LB)
      if (padIsWheel) {
        try {
          for (let bi = 8; bi < 16; bi += 1) {
            if (padHeld(pad, bi)) { gpNitro = true; break }
          }
        } catch {}
      }
      gpHornEdge = padEdge(pad, BTN.RB)
      // Y exits too (B still works — the smoke test drives B, muscle memory
      // either). Same 350 ms mount guard as F.
      if ((padEdge(pad, BTN.B) || padEdge(pad, BTN.Y)) && performance.now() - mountedAt.current >= 350) {
        driveOrbit.yaw = 0 // hand a clean camera back to the on-foot rig
        exitCar()
      }
      // Crash rumble is fired from the damage sync below (change-gated).
    }

    const v = rb.linvel()
    const rot = rb.rotation()
    q.set(rot.x, rot.y, rot.z, rot.w)
    fwd.set(0, 0, 1).applyQuaternion(q)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1)
    fwd.normalize()

    const tuning = getCarTuning(carId)
    const baseTurnRate = tuning.turnRate

    right.crossVectors(fwd, up).normalize()

    const fwdV = v.x * fwd.x + v.z * fwd.z
    const sideV = v.x * right.x + v.z * right.z
    const planarSpeed = Math.hypot(v.x, v.z)

    const wantF = keys.current.fwd || gpF > 0.15
    const wantB = keys.current.back || gpB > 0.15
    const isBraking = keys.current.brake || gpBr
    const aF = Math.max(keys.current.fwd ? 1 : 0, gpF)
    const aB = Math.max(keys.current.back ? 1 : 0, gpB)
    const power = 1 - 0.65 * dmg

    let surfaceMul = 1
    try { surfaceMul = isOnAsphalt(tNow.x, tNow.z) ? 1 : 0.55 } catch (e) { surfaceMul = 1 }

    // Nitro recomputed AFTER wantF/wantB exist (uses the live pedal state).
    const nitroNow = !!(keys.current.nitro || gpNitro) && (wantF || wantB)
    const nitroSpd = nitroNow ? NITRO_SPEED_MUL : 1
    const maxSpd = tuning.maxSpeed * nitroSpd
    const revSpd = tuning.reverseMax * (nitroNow ? 1.15 : 1)
    const tauNow = tuning.accelTau / (nitroNow ? NITRO_ACCEL_MUL : 1)

    const targetFwd = wantF
      ? maxSpd * power * surfaceMul * aF
      : wantB
      ? -revSpd * power * Math.max(0.6, surfaceMul) * aB
      : 0

    const tau = wantF || wantB ? tauNow : 0.22
    const lerpRate = 1 - Math.pow(0.0015, delta / tau)
    let newFwdV = fwdV + (targetFwd - fwdV) * lerpRate

    const nowMs = typeof performance !== 'undefined' ? performance.now() : 0
    const lastHitTime = spotIndex != null && spotIndex >= 0
      ? (crash.lastHit[spotIndex] ?? 0)
      : aiIndex != null && aiIndex >= 0
      ? (crash.lastAiHit[aiIndex] ?? 0)
      : 0
    if (nowMs - lastHitTime < 150) {
      newFwdV *= 0.3
    }

    if (isBraking) {
      // During a high-speed drift the handbrake only bleeds speed slowly (the
      // slide needs forward momentum to carry); otherwise brake hard to a stop.
      const driftDecel = planarSpeed > 6.0 && Math.abs(fwdV) > 4.0 ? 0.9 : 6
      newFwdV = Math.abs(fwdV) > 0.4 ? fwdV * Math.max(0, 1 - driftDecel * delta) : 0
    }

    let grip = tuning.grip
    if (isBraking) {
      // Handbrake DRIFT: at speed, the brake drops lateral grip hard so the
      // rear slides and steering rotates the car beyond its travel direction
      // (the kept sideV is exactly the drift). Slow-speed braking stays a
      // plain stop.
      if (planarSpeed > 6.0 && Math.abs(fwdV) > 4.0) grip = 0.22
      else grip = 0.60
    } else if (Math.abs(sideV) > 2.0 && planarSpeed > 5.0) {
      grip = 0.68
    }
    const lateralDecay = 1 - Math.pow(1 - grip, delta * 30)
    let newSideV = sideV * (1 - lateralDecay)

    if (planarSpeed > 4.2 && (Math.abs(sideV) > 2.0 || (isBraking && planarSpeed > 6.0))) {
      try { audio.screech(Math.min(1, planarSpeed / 14)) } catch { /* silent */ }
    }

    const newVx = fwd.x * newFwdV + right.x * newSideV
    const newVz = fwd.z * newFwdV + right.z * newSideV
    rb.setLinvel({ x: newVx, y: v.y, z: newVz }, true)

    const steerRaw = (keys.current.right ? 1 : 0) - (keys.current.left ? 1 : 0) + gpS
    const steer = steerRaw

    steerRef.current = THREE.MathUtils.lerp(steerRef.current, steer, Math.min(1, delta * 16))

    const absSpeed = Math.abs(fwdV)
    const throttleActive = wantF || wantB
    let turnFactor = throttleActive ? Math.max(0.75, Math.min(1, absSpeed / 3)) : Math.max(0.4, Math.min(1, absSpeed / 3))
    if (absSpeed > 16) {
      turnFactor *= Math.max(0.7, 1 - (absSpeed - 16) * 0.03)
    }
    if (isBraking && absSpeed > 2) {
      turnFactor *= 1.35
    }

    // No gas = no turn: a stationary car can't steer. Scale the turn rate by
    // how fast the car is actually rolling (reversing counts — real cars steer
    // while rolling backward too); full authority from ~1.2 m/s upward or
    // immediate responsive steering when applying throttle/brake pedal.
    const rollingFloor = throttleActive ? 0.35 : 0
    const rolling = Math.min(1, rollingFloor + Math.min(1, absSpeed / 1.2) * (1 - rollingFloor))
    const steerDir = fwdV < -0.2 ? -1 : 1
    const angY = -steerRef.current * baseTurnRate * turnFactor * (1 - 0.3 * dmg) * rolling * steerDir
    rb.setAngvel({ x: 0, y: angY, z: 0 }, true)

    // Feed the visual layer (CarAnim wheels/suspension + brake lights) + FOV.
    try {
      if (spotIndex != null && spotIndex >= 0) setAnimSpot(spotIndex, newFwdV, steerRef.current, nitroNow, isBraking)
    } catch {}

    // Horn (keyboard H edge, gamepad RB edge), throttled so it can't spam.
    try {
      if (gpHornEdge) {
        const now = performance.now()
        if (now - hornAt.current > 900 || hornAt.current === 0) {
          hornAt.current = now
          audio.horn(1)
        }
      }
    } catch {}

    // Speed-sensitive FOV: settings FOV + speed add + nitro add, lerped so it
    // never pops. Writes straight to the live camera (FovSync owns settings
    // changes; this only adds the transient kick while driving).
    try {
      const cam = frameState.camera
      if (cam) {
        const gs = useGameStore.getState()
        const baseFov = gs.settings?.fov ?? 68
        const spd01 = Math.min(1, Math.abs(newFwdV) / Math.max(1, maxSpd))
        const target = baseFov + spd01 * FOV_SPEED_ADD + (nitroNow ? FOV_NITRO_ADD : 0)
        if (fovCur.current == null) fovCur.current = cam.fov
        fovCur.current += (target - fovCur.current) * Math.min(1, delta * 5)
        if (Math.abs(fovCur.current - cam.fov) > 0.05) {
          cam.fov = fovCur.current
          cam.updateProjectionMatrix()
        }
      }
    } catch {}

    if (modelRef?.current) {
      const accelAmt = (newFwdV - fwdV) / Math.max(0.01, delta)
      const pitchTarget = Math.max(-0.06, Math.min(0.06, -accelAmt * 0.003))
      const rollTarget = Math.max(-0.08, Math.min(0.08, -steerRef.current * (planarSpeed / 15) * 0.05))
      modelRef.current.rotation.x = THREE.MathUtils.lerp(modelRef.current.rotation.x, pitchTarget, Math.min(1, delta * 8))
      modelRef.current.rotation.z = THREE.MathUtils.lerp(modelRef.current.rotation.z, rollTarget, Math.min(1, delta * 8))
    }
  })

  useEffect(() => {
    const down = (e) => {
      const a = KEY_MAP[e.code]
      if (a) {
        // Horn is edge-triggered (H): fire once per press, throttled.
        if (a === 'horn') {
          if (!e.repeat) {
            const now = typeof performance !== 'undefined' ? performance.now() : 0
            if (now - hornAt.current > 900 || hornAt.current === 0) {
              hornAt.current = now
              try { audio.horn(1) } catch {}
            }
          }
          return
        }
        keys.current[a] = true
      }
    }
    const up = (e) => { const a = KEY_MAP[e.code]; if (a && a !== 'horn') keys.current[a] = false }
    const blur = () => Object.keys(keys.current).forEach((k) => (keys.current[k] = false))
    const onExit = (e) => {
      const isExit = e.code === 'KeyF' || e.code === 'KeyY'
      if (!isExit || e.repeat) return
      if (performance.now() - mountedAt.current < 350) return
      driveOrbit.yaw = 0 // hand a clean camera back to the on-foot rig
      exitCar()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', onExit)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', onExit)
      Object.keys(keys.current).forEach((k) => (keys.current[k] = false))
    }
  }, [exitCar])

  return (
    <>
      <CameraRig bodyRef={bodyRef} modelRef={modelRef} lookHeight={1.0} />
      <OrbitInput />
    </>
  )
}

export const LooseSettler = () => {
  // Live rapier module for the numeric RigidBodyType enum (crashManager note).
  const { rapier } = useRapier()
  useFrame(() => {
    if (crash.loose.size === 0) return
    const now = performance.now()
    const driving = useGameStore.getState().driving
    // No spread/alloc: iterate live, collect drops in a small stack array.
    let dropped = null
    for (const i of crash.loose) {
      // Being driven: CarDriver + the `dynamic` prop own this body now.
      if (i === driving) { (dropped || (dropped = [])).push(i); continue }
      const rb = crash.bodies[i]
      if (!rb) { (dropped || (dropped = [])).push(i); continue }
      const t = rb.translation()
      crash.setLive(i, t.x, t.z)
      const lv = rb.linvel(), av = rb.angvel()
      const settled = Math.hypot(lv.x, lv.z) < 0.15 && Math.abs(av.y) < 0.12
      if (settled || now - (crash.looseSince[i] ?? 0) > LOOSE_MAX_MS) {
        try {
          rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
          rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
        } catch {}
        // Numeric enum (see crashManager.js): a string would be Dynamic = 0,
        // i.e. the car would never actually re-freeze.
        setRigidBodyType(rb, 'fixed', rapier)
        ;(dropped || (dropped = [])).push(i)
      }
    }
    if (dropped) for (const i of dropped) crash.loose.delete(i)
  })
  useEffect(() => () => { crash.loose.clear() }, [])
  return null
}
