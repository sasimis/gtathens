import React, { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'
import * as THREE from 'three'
import useGameStore, { CAM_VIEWS, Phase } from '../store/useGameStore'

// Fixed third-person chase camera. No free zoom / no scroll resize by design:
// keys 1/2/3 jump straight to Near / Standard / Far, V cycles them.
// Dragging vertically still nudges pitch a little around the preset; scroll
// does nothing. `orbit` keeps only the small pitch trim (shared on-foot +
// driving so the view never jumps when entering/exiting a car).
export const orbit = { pitchTrim: 0 }
const TRIM_MIN = -0.25
const TRIM_MAX = 0.3
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

// Reusable temp vectors to avoid per-frame allocations (ray origin/dir use
// plain locals now — Rapier wants fresh {x,y,z} objects, not Vector3s).
const camGoal = new THREE.Vector3()
const lookGoal = new THREE.Vector3()
const rigidPos = new THREE.Vector3()
const facing = new THREE.Vector3()
const quatTmp = new THREE.Quaternion()

// QA hook for scripts/smoke.mjs: the resolved camera pose + view yaw, written
// into ONE stable object per frame (three number writes, zero allocation) so a
// headless test can assert "W moves the player AWAY from the camera". Same
// stable-reference pattern as DebugOverlay's statsSnap.
const camTrace = { x: 0, y: 0, z: 0, yaw: 0 }
if (typeof window !== 'undefined') window.__gtathensCam = camTrace

/**
 * Follow camera shared by the on-foot player and the driven car.
 * `bodyRef` must point at a Rapier rigid body, `modelRef` at an Object3D whose
 * world quaternion tracks the body's heading (the character model group, or the
 * car's model group) so the camera orbits to stay "behind" the movement.
 * `lookHeight` is the world-space height of the point the camera aims at.
 */
export const CameraRig = ({ bodyRef, modelRef, lookHeight = 1.2, yawRef = null }) => {
  const snapRef = useRef(true)
  const settings = useGameStore((s) => s.settings)
  const camView = useGameStore((s) => s.camView ?? 1)
  const phase = useGameStore((s) => s.phase)
    const { world, rapier } = useRapier()

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const camViewRef = useRef(camView)
  camViewRef.current = camView
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  // Snap the follow camera behind the player as soon as play starts,
  // instead of lerping across the whole map from the menu orbit.
  useEffect(() => {
    if (phase === Phase.PLAYING) snapRef.current = true
  }, [phase])

  useFrame((state, delta) => {
    // ecctrl v1 does not expose a position getter: read the Rapier rigid
    // body translation straight off the forwarded ref (RapierRigidBody).
    const body = bodyRef.current
    const model = modelRef ? modelRef.current : null
    if (!body || typeof body.translation !== 'function') return
    // The model's quaternion is only needed when the view follows a heading.
    if (!yawRef && (!model || typeof model.getWorldQuaternion !== 'function')) return
    const t = body.translation()
    rigidPos.set(t.x, t.y, t.z)

    // View direction = the way the camera looks (where W drives you). The camera
    // then sits opposite it, i.e. behind.
    //
    // Two sources, because the two rigs have opposite model conventions:
    //  - DRIVING: the car's model group sits inside the body with no extra
    //    rotation, so the model's world +Z IS the nose. Following the model
    //    quaternion keeps the camera behind the car as it steers.
    //  - ON FOOT: the character's model group is rotated `yaw + PI` (its FBX
    //    faces -Z), so its world +Z is the character's BACK. Deriving the view
    //    from it aimed the camera at the character's face and whipped it 180 deg
    //    every time the movement direction reversed -- pressing S span the world
    //    around instead of walking backwards. On foot we use the free-orbit yaw
    //    (`camYaw`), which is also the movement basis, so W always walks away
    //    from the camera, S walks back toward it, and the camera stays put.
    if (yawRef && typeof yawRef.current === 'number') {
      const y = yawRef.current
      facing.set(Math.sin(y), 0, Math.cos(y))
    } else {
      facing.set(0, 0, 1).applyQuaternion(model.getWorldQuaternion(quatTmp))
      facing.y = 0
      if (facing.lengthSq() > 1e-6) facing.normalize()
    }

    const s = settingsRef.current
    // Fixed preset: distance/height/pitch come from the store (1/2/3 or V).
    // Wheel-zoom is disabled — no per-frame allocation-free zoom math.
    const view = CAM_VIEWS[camViewRef.current] ?? CAM_VIEWS[1]
    const dist = view.distance
    const pitch = clamp(view.pitch + orbit.pitchTrim, -0.05, 1.1)
    const cp = Math.cos(pitch)
    // Camera sits BEHIND the car/character (opposite the facing vector).
    let camX = rigidPos.x - facing.x * dist * cp
    // Keep a low floor so a downward ray never drags the camera underground
    // (and the pitch change above keeps the framing), then the wall raycast
    // below pulls the camera in front of buildings instead of inside them.
    let camY = Math.max(rigidPos.y + view.height + dist * Math.sin(pitch), 1.1)
    let camZ = rigidPos.z - facing.z * dist * cp

    // Camera collision - raycast from the head toward the desired spot.
    // The player's own capsule sits ~1 m behind the ray origin, so hits
    // closer than 0.4 m are ignored (self-guard); anything further pulls
    // the camera in front of the wall instead of inside it.
    const ox = rigidPos.x
    const oy = rigidPos.y + lookHeight
    const oz = rigidPos.z
    let dx = camX - ox
    let dy = camY - oy
    let dz = camZ - oz
    const rayLen = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (rayLen > 0.01 && rapier && world) {
      dx /= rayLen
      dy /= rayLen
      dz /= rayLen
      // Fresh WASM Ray each frame (reusing breaks Rapier's internal Vector3).
      let cameraRay = null
      try {
        cameraRay = new rapier.Ray(
          { x: ox, y: oy, z: oz },
          { x: dx, y: dy, z: dz },
        )
      } catch (e) {
        cameraRay = null
      }
      if (cameraRay) {
        let hit = null
        try {
          // Compat build: castRayAndGetNormal(ray, maxToi, solid,
          //   filterFlag?, filterGroups?, excludeCollider?, excludeBody?).
          // Called with just (ray, maxToi, solid) so other bodies' filters
          // still apply; our own body is skipped via the distance guard below
          // (timeOfImpact > 0.4 m — the capsule is ~1 m behind the head ray).
          hit =
            typeof world.castRayAndGetNormal === 'function'
              ? world.castRayAndGetNormal(cameraRay, rayLen, true)
              : world.castRay(cameraRay, rayLen, true)
        } catch (e) {
          hit = null
        }
        try {
          if (cameraRay && typeof cameraRay.free === 'function') cameraRay.free()
        } catch (e) {
          /* ignore */
        }
        const toi = hit ? hit.timeOfImpact ?? hit.toi : undefined
        if (typeof toi === 'number' && toi > 0.4 && toi < rayLen) {
          // Pull the camera just in front of the wall (0.45 m margin), but
          // never closer than 1.2 m to the head — that reads as a shoulder
          // cam instead of a wall clip.
          const safeDist = Math.min(rayLen, Math.max(1.2, toi - 0.45))
          camX = ox + dx * safeDist
          camY = Math.max(oy + dy * safeDist, 0.7)
          camZ = oz + dz * safeDist
        }
      }
    }
    camGoal.set(camX, camY, camZ)

    // FIX: on (re-)entering play the camera teleports to the follow point
    if (snapRef.current || phaseRef.current !== Phase.PLAYING) {
      state.camera.position.copy(camGoal)
      snapRef.current = false
    } else {
      const k = 1 - Math.pow(1 - Math.min(s.smoothing, 0.95), delta * 60)
      state.camera.position.lerp(camGoal, k)
    }
    lookGoal.set(rigidPos.x, rigidPos.y + lookHeight, rigidPos.z)
    state.camera.lookAt(lookGoal)

    // QA hook (see camTrace): resolved pose + the yaw W moves along.
    camTrace.x = state.camera.position.x
    camTrace.y = state.camera.position.y
    camTrace.z = state.camera.position.z
    camTrace.yaw = Math.atan2(facing.x, facing.z)
  })

  return null
}

/**
 * Pointer + view-key input for the fixed chase camera. Only active while
 * PLAYING: vertical left-drag nudges pitch slightly around the current
 * preset. The mouse wheel is intentionally IGNORED (block page scroll while
 * playing but never resize the follow distance). Keys 1/2/3 jump to a view,
 * V cycles. Horizontal yaw still comes from the player drag handler / car
 * heading — CameraRig follows facing automatically.
 */
export const OrbitInput = () => {
  const phase = useGameStore((s) => s.phase)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const drag = useRef(null)

  useEffect(() => {
    const onDown = (e) => {
      if (phaseRef.current !== Phase.PLAYING || e.button !== 0) return
      drag.current = { x: e.clientX, y: e.clientY }
    }
    const onUp = () => {
      drag.current = null
    }
    const onMove = (e) => {
      const last = drag.current
      if (!last) return
      const dy = e.clientY - last.y
      last.x = e.clientX
      last.y = e.clientY
      // 0.005 rad per px of vertical drag — small trim around the preset pitch
      orbit.pitchTrim = clamp(orbit.pitchTrim + dy * 0.005, TRIM_MIN, TRIM_MAX)
    }
    const onWheel = (e) => {
      // Fixed camera: no zoom. Just stop the page from scrolling.
      if (phaseRef.current !== Phase.PLAYING) return
      e.preventDefault()
    }
    const onViewKey = (e) => {
      if (e.repeat) return
      if (phaseRef.current !== Phase.PLAYING) return
      const st = useGameStore.getState()
      if (e.code === 'KeyV') st.cycleCamView()
      else if (e.code === 'Digit1' || e.code === 'Numpad1') st.setCamView(0)
      else if (e.code === 'Digit2' || e.code === 'Numpad2') st.setCamView(1)
      else if (e.code === 'Digit3' || e.code === 'Numpad3') st.setCamView(2)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onUp)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onViewKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onViewKey)
    }
  }, [])

  return null
}