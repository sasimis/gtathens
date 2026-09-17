import React, { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import DynamicSky from './DynamicSky'
import Stars from './Stars'
import useGameStore from '../store/useGameStore'

export const DAY_DURATION = 48 * 60 // 48 minutes for full cycle

const SKY_COLORS = {
  night: { top: new THREE.Color('#0a0a1a'), bottom: new THREE.Color('#1a1a3a'), sun: new THREE.Color('#4466aa'), ambient: 0.15, sunIntensity: 0 },
  sunrise: { top: new THREE.Color('#1a2a5a'), bottom: new THREE.Color('#ff8844'), sun: new THREE.Color('#ffaa44'), ambient: 0.35, sunIntensity: 0.8 },
  day: { top: new THREE.Color('#4488cc'), bottom: new THREE.Color('#88bbee'), sun: new THREE.Color('#ffffee'), ambient: 0.55, sunIntensity: 1.2 },
  sunset: { top: new THREE.Color('#2a1a4a'), bottom: new THREE.Color('#ff6633'), sun: new THREE.Color('#ff8833'), ambient: 0.3, sunIntensity: 0.7 },
}

// Phase boundaries (module scope: the old inline literal allocated an object
// on every single frame).
const SKY_PHASES = { NIGHT: 0, SUNRISE_S: 5, SUNRISE_E: 7, DAY_S: 8, DAY_E: 17, SUNSET_S: 18, SUNSET_E: 20 }

function getSkyColors(time, out) {
  const P = SKY_PHASES
  let from, to, t
  if (time < P.SUNRISE_S) return SKY_COLORS.night
  if (time < P.SUNRISE_E) { from = SKY_COLORS.night; to = SKY_COLORS.sunrise; t = (time - P.SUNRISE_S) / 2 }
  else if (time < P.DAY_S) { from = SKY_COLORS.sunrise; to = SKY_COLORS.day; t = (time - P.SUNRISE_E) / 1 }
  else if (time < P.DAY_E) return SKY_COLORS.day
  else if (time < P.SUNSET_S) { from = SKY_COLORS.day; to = SKY_COLORS.sunset; t = (time - P.DAY_E) / 1 }
  else if (time < P.SUNSET_E) { from = SKY_COLORS.sunset; to = SKY_COLORS.night; t = (time - P.SUNSET_S) / 2 }
  else return SKY_COLORS.night

  // Lerp IN PLACE into `out` — the old version called `.clone()` three times
  // per frame, i.e. ~5 short-lived Colors/frame of GC churn for the whole
  // transition half of the day. Callers only READ these (copy/lerp), and the
  // three static SKY_COLORS entries returned above are never mutated.
  out.top.copy(from.top).lerp(to.top, t)
  out.bottom.copy(from.bottom).lerp(to.bottom, t)
  out.sun.copy(from.sun).lerp(to.sun, t)
  out.ambient = from.ambient + (to.ambient - from.ambient) * t
  out.sunIntensity = from.sunIntensity + (to.sunIntensity - from.sunIntensity) * t
  return out
}

function getSunDirection(time, out) {
  const angle = ((time - 6) / 12) * Math.PI
  return out.set(Math.cos(angle), Math.sin(angle), 0.3)
}

// Module-level scratch (no per-frame allocation) + HUD clock throttle.
const tmpCamDir = new THREE.Vector3()
const tmpShadowTarget = new THREE.Vector3()
const tmpSunDir = new THREE.Vector3()
const COLOR_WHITE = new THREE.Color('#ffffff')
const tmpHemi = new THREE.Color()
// Result buffer reused by getSkyColors so the blend writes nowhere new.
const skyOut = {
  top: new THREE.Color(),
  bottom: new THREE.Color(),
  sun: new THREE.Color(),
  ambient: 0,
  sunIntensity: 0,
}
const hudClock = { acc: 1 }

const DayNightCycle = ({ shadows = true }) => {
  const timeRef = useRef(8)
  const sunRef = useRef()
  // Shadow focus = smoothed follow-target the directional shadow box tracks.
  const shadowFocus = useRef(new THREE.Vector3(0, 0, 0))
  const shadowInit = useRef(false)
  const ambientRef = useRef()
  const hemiRef = useRef()
  const skyRef = useRef()
  const starsRef = useRef()
  const moonRef = useRef()
  const setGameTime = useGameStore((s) => s.setGameTime)

  useFrame((state, delta) => {
    // Advance time using ref (no React re-render)
    timeRef.current = (timeRef.current + (delta / DAY_DURATION) * 24) % 24
    const time = timeRef.current
    // Throttle the zustand write: HUD clock only needs ~4 Hz, and setGameTime
    // re-renders HUD subscribers — writing every frame wastes React work.
    hudClock.acc += delta
    if (hudClock.acc >= 0.25) {
      hudClock.acc = 0
      setGameTime(time)
    }

    // Ease the shadow focus toward the camera look-target each frame
    // (cheap: camera moves smoothly already, so a light lerp kills jitter).
    try {
      const cam = state.camera
      const dir = cam.getWorldDirection(tmpCamDir)
      tmpShadowTarget.copy(cam.position).addScaledVector(dir, 12)
      tmpShadowTarget.y = 0
      if (!shadowInit.current) {
        shadowFocus.current.copy(tmpShadowTarget)
        shadowInit.current = true
      } else {
        shadowFocus.current.lerp(tmpShadowTarget, 1 - Math.exp(-4 * Math.min(delta, 0.1)))
      }
    } catch (e) {
      /* ignore */
    }

    const colors = getSkyColors(time, skyOut)
    const sunDir = getSunDirection(time, tmpSunDir)

    // Update sun light — the shadow camera follows the follow-target so the
    // 120 m ortho box stays centered on the player/car (tight texel density
    // = smooth, non-gonky shadows instead of one 1400 m stretched box).
    if (sunRef.current) {
      const focus = shadowFocus.current
      sunRef.current.position.set(
        focus.x + sunDir.x * 300,
        focus.y + sunDir.y * 300,
        focus.z + sunDir.z * 300,
      )
      sunRef.current.target.position.copy(focus)
      sunRef.current.target.updateMatrixWorld()
      sunRef.current.color.copy(colors.sun)
      sunRef.current.intensity = colors.sunIntensity * 1.5
    }

    // Update ambient light
    if (ambientRef.current) {
      ambientRef.current.intensity = colors.ambient
    }

    // Update hemisphere light
    if (hemiRef.current) {
      hemiRef.current.color.copy(tmpHemi.copy(colors.top).lerp(COLOR_WHITE, 0.3))
      hemiRef.current.intensity = colors.ambient * 0.5
    }

    // Update sky shader uniforms
    if (skyRef.current) {
      const u = skyRef.current.material.uniforms
      u.sunDirection.value.copy(sunDir)
      u.sunColor.value.copy(colors.sun)
      u.skyTopColor.value.copy(colors.top)
      u.skyBottomColor.value.copy(colors.bottom)
      u.sunIntensity.value = colors.sunIntensity
    }

    // Update moon
    if (moonRef.current) {
      moonRef.current.position.copy(sunDir).multiplyScalar(-500)
    }

    // Toggle stars visibility
    if (starsRef.current) {
      starsRef.current.visible = time < 5 || time > 20
    }
  })

  return (
    <>
      <DynamicSky ref={skyRef} />
      <directionalLight ref={sunRef} castShadow={shadows} shadow-mapSize={[2048, 2048]} shadow-camera-left={-60} shadow-camera-right={60} shadow-camera-top={60} shadow-camera-bottom={-60} shadow-camera-near={10} shadow-camera-far={900} shadow-bias={-0.00012} shadow-normalBias={0.6} />
      <ambientLight ref={ambientRef} />
      <hemisphereLight ref={hemiRef} args={[undefined, '#8a7a55', undefined]} />
      <Stars ref={starsRef} count={1500} />
      <directionalLight ref={moonRef} color="#4466aa" intensity={0.15} />
    </>
  )
}

export default DayNightCycle
