
import { useCallback, useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import * as THREE from 'three'
import useGameStore, { Phase } from '../../store/useGameStore'
import { CameraRig, OrbitInput } from '../FollowCamera'
import { BTN, getGamepad, padEdge, padHeld, padValue, readStick } from '../../lib/gamepad'
import { CAR_MAX_SPEED, CAR_REVERSE_MAX, CAR_TURN_RATE, LOOSE_MAX_MS, getCarTuning } from './constants.js'
import { crash, isOnAsphalt, aiDamage, setAiCarOccupied, setRigidBodyType } from './crashManager.js'
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
}

export const CarDriver = ({ bodyRef, modelRef, spotIndex = null, half = null, aiIndex = null, carId = null }) => {
  const phase = useGameStore((s) => s.phase)
  const setCarDamage = useGameStore((s) => s.setCarDamage)
  const { world, rapier } = useRapier()
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const mountedAt = useRef(typeof performance !== 'undefined' ? performance.now() : 0)
  const keys = useRef({ fwd: false, back: false, left: false, right: false, brake: false })
  const dmgSync = useRef({ idx: null, val: 0 })
  const steerRef = useRef(0)

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

  useFrame((_, delta) => {
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
    const syncIdx = spotIndex != null ? spotIndex : aiIndex != null && aiIndex >= 0 ? `ai${aiIndex}` : null
    if (syncIdx !== dmgSync.current.idx || Math.abs(dmg - dmgSync.current.val) > 0.001) {
      dmgSync.current = { idx: syncIdx, val: dmg }
      setCarDamage(dmg)
    }

    if (phaseRef.current !== Phase.PLAYING) {
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true)
      return
    }

    const pad = getGamepad()
    let gpF = 0, gpB = 0, gpS = 0, gpBr = false
    if (pad) {
      gpF = padValue(pad, BTN.RT)
      gpB = padValue(pad, BTN.LT)
      gpS = readStick(pad, 0)
      gpBr = padHeld(pad, BTN.A)
      if (padEdge(pad, BTN.B) && performance.now() - mountedAt.current >= 350) exitCar()
    }

    const v = rb.linvel()
    const rot = rb.rotation()
    q.set(rot.x, rot.y, rot.z, rot.w)
    fwd.set(0, 0, 1).applyQuaternion(q)
    fwd.y = 0
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1)
    fwd.normalize()

    const tuning = getCarTuning(carId)
    const maxSpeed = tuning.maxSpeed
    const reverseMax = tuning.reverseMax
    const baseTurnRate = tuning.turnRate
    const accelTau = tuning.accelTau

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

    const targetFwd = wantF
      ? maxSpeed * power * surfaceMul * aF
      : wantB
      ? -reverseMax * power * Math.max(0.6, surfaceMul) * aB
      : 0

    // Active counter-braking (e.g. pressing S while going forward or W while in reverse)
    const isCounterBraking = (fwdV > 0.5 && wantB) || (fwdV < -0.5 && wantF)
    const tau = isCounterBraking ? accelTau * 0.4 : (wantF || wantB ? accelTau : 0.22)
    const lerpRate = 1 - Math.pow(0.0015, delta / tau)
    let newFwdV = fwdV + (targetFwd - fwdV) * lerpRate
    if (isBraking) {
      newFwdV = Math.abs(fwdV) > 0.4 ? fwdV * Math.max(0, 1 - 7 * delta) : 0
    }

    let grip = tuning.grip
    if (isBraking) {
      grip = 0.60
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

    steerRef.current = THREE.MathUtils.lerp(steerRef.current, steer, Math.min(1, delta * 24))

    const absSpeed = Math.abs(fwdV)
    let turnFactor = Math.max(0.75, Math.min(1, absSpeed / 3.5))
    if (absSpeed > 16) {
      turnFactor *= Math.max(0.7, 1 - (absSpeed - 16) * 0.03)
    }
    if (isBraking && absSpeed > 2) {
      turnFactor *= 1.35
    }

    // Fix reverse steering: invert angY when moving backward or intending to back up
    const isReversing = fwdV < -0.1 || (wantB && fwdV <= 0.1)
    const reverseDir = isReversing ? -1 : 1

    const angY = -steerRef.current * baseTurnRate * turnFactor * (1 - 0.3 * dmg) * reverseDir
    rb.setAngvel({ x: 0, y: angY, z: 0 }, true)

    if (modelRef?.current) {
      const accelAmt = (newFwdV - fwdV) / Math.max(0.01, delta)
      const pitchTarget = Math.max(-0.07, Math.min(0.07, -accelAmt * 0.0035))
      const rollTarget = Math.max(-0.09, Math.min(0.09, -steerRef.current * (planarSpeed / 15) * 0.06))
      modelRef.current.rotation.x = THREE.MathUtils.lerp(modelRef.current.rotation.x, pitchTarget, Math.min(1, delta * 10))
      modelRef.current.rotation.z = THREE.MathUtils.lerp(modelRef.current.rotation.z, rollTarget, Math.min(1, delta * 10))
    }
  })

  useEffect(() => {
    const down = (e) => { const a = KEY_MAP[e.code]; if (a) keys.current[a] = true }
    const up = (e) => { const a = KEY_MAP[e.code]; if (a) keys.current[a] = false }
    const blur = () => Object.keys(keys.current).forEach((k) => (keys.current[k] = false))
    const onExit = (e) => {
      if (e.code !== 'KeyF' || e.repeat) return
      if (performance.now() - mountedAt.current < 350) return
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
