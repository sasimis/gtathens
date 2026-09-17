// <AudioSystem> — mounts the audio stack inside <Canvas> and drives the 3D
// engine nodes every frame. The 2D bus (howler) needs no React at all; this
// component exists for the parts that need THREE context:
//   1. attach the ONE shared AudioListener (lib/audio.js) to the camera
//   2. build the positional engine/hum pool once the scene exists
//   3. per frame: place + pitch each engine node from the live rapier bodies
//      (driven car via getCarBody(driving), AI cars via AI_CAR_LIVE + speed)
//   4. autoplay unlock + ambience start on first PLAY
import React, { useEffect, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import useGameStore, { Phase } from '../store/useGameStore'
import { getCarBody } from './Car'
import { AI_CAR_LIVE } from './Car'
import { audio, getListener, setListenerXZ, bedsUpdate, trafficHorn } from '../lib/audio'

// Throttle for the day/night bed crossfade (uses the ~4 Hz game clock).
let lastBedsAt = 0

const AudioSystem = () => {
  const camera = useThree((s) => s.camera)
  const scene = useThree((s) => s.scene)
  const startedRef = useRef(false)

  // Audio contexts (THREE + Howler) are created on the FIRST user gesture —
  // Chrome's autoplay policy blocks AudioContext creation otherwise.
  // PLAY's pointerdown/keydown fires unlock(), which:
  //   1. resume() → creates AudioListener + Howl objects, resumes both contexts
  //   2. attaches the shared listener to the camera
  //   3. builds the positional engine/hum pool (initPositional)
  //   4. starts the 2D ambient bed
  useEffect(() => {
    let disposed = false
    const unlock = () => {
      if (startedRef.current) return
      startedRef.current = true
      audio.resume()                    // creates listener + Howl objects, resumes both
      camera.add(getListener())         // attach shared listener to camera
      audio.initPositional(scene).then(() => {
        if (!disposed) audio.setMasterVolume(useGameStore.getState().settings.sfxVolume ?? 1)
      })
      audio.startAmbient()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
      if (startedRef.current) camera.remove(getListener())
      disposed = true
    }
  }, [camera, scene])

  // Engine nodes: driven car (slot 0) + 5 AI cars (slots 1..5). Positions and
  // speeds come from module state — zero React re-renders, zero allocations.
  // Also feeds the camera XZ into setListenerXZ (positional 2D culling) and
  // crossfades the day/night beds on the ~4 Hz game clock.
  useFrame((state) => {
    const gs = useGameStore.getState()
    const on = gs.phase === Phase.PLAYING
    // Listener position for positional one-shot culling (stable numbers only).
    try {
      const cp = state.camera.position
      setListenerXZ(cp.x, cp.z)
    } catch { /* camera not ready */ }
    // Day/night beds follow the HUD clock (~4 Hz writes from DayNightCycle).
    const now = typeof performance !== 'undefined' ? performance.now() : 0
    if (on && now - lastBedsAt > 250) {
      lastBedsAt = now
      try { bedsUpdate(gs.gameTime ?? 8) } catch { /* beds not loaded yet */ }
      // Distant traffic horns: the street feels alive without a new asset per
      // car — count AI cars in earshot (already published, no alloc).
      try {
        let near = 0
        const cp = state.camera.position
        for (let k = 0; k < 5; k += 1) {
          const lv = AI_CAR_LIVE[k]
          if (!lv) continue
          const dx = lv.x - cp.x
          const dz = lv.z - cp.z
          if (dx * dx + dz * dz < 120 * 120) near += 1
        }
        trafficHorn(near)
      } catch { /* ambience only */ }
    }
    // Driven car: live rapier body.
    let driven = null
    if (on && gs.driving !== null && gs.driving !== undefined) {
      try {
        const rb = getCarBody(gs.driving)
        if (rb) {
          const t = rb.translation()
          const v = rb.linvel()
          driven = { x: t.x, y: t.y, z: t.z, speed: Math.hypot(v.x, v.z) }
        }
      } catch (e) { /* body gone between frames */ }
    }
    audio.engineUpdate(0, driven ? driven.x : 0, driven ? driven.y : 0, driven ? driven.z : 0,
      driven ? Math.min(1, driven.speed / 17) : 0, !!driven)
    // AI traffic: AI_CAR_LIVE[i] = {x, z, speed, yaw} mutated in place by AiCar.
    // Kinematic bodies still push dynamic ones through CONTACTS (solver), but
    // car-vs-car IMPACT events + crash damage only fire between two colliders
    // that both accept GROUP_CAR — the filter below is two-sided, so AI cars
    // now thump parked cars (and each other) instead of ghosting through.
    for (let i = 0; i < 5; i += 1) {
      const live = AI_CAR_LIVE[i]
      const active = on && !!live
      audio.engineUpdate(i + 1, live ? live.x : 0, 0.5, live ? live.z : 0,
        active ? Math.min(1, (live.speed || 0) / 8) : 0, active)
    }
  })

  return null
}

export default AudioSystem
