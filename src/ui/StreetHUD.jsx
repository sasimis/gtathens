// Street-name HUD: bottom-right chip showing the nearest street, on foot AND
// while driving. DOM overlay (mounted by MenuRoot next to Hud) — reads the
// published road-segment cache + stable QA traces, throttled to ~5 Hz, and
// animates in/out with framer-motion on change.
//
// Position source: window.__gtathensPlayer (stable object Player.jsx writes
// every physics frame) on foot; the DRIVEN car's live body position while
// driving (the on-foot Player is unmounted then, so its trace is stale).
// No store writes, no re-renders of the 3D scene — useState only in this chip.
import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import useGameStore, { Phase } from '../store/useGameStore'
import { streetLabelFor } from '../components/Roads'

// Local point-to-segment distance (numbers only, no alloc). Duplicated from
// City.jsx's planBuildings helper on purpose: importing City.jsx from a DOM
// overlay module would drag drei/Rapier into the HUD bundle AND create a
// City <-> overlay import cycle. Keep the two copies in sync (both are the
// standard projection-clamped distance).

const STREET_POLL_MS = 300 // same cadence as the car enter-detection poll
const STREET_RANGE_M = 25 // beyond this we are off-road

const pointToSegmentDist = (px, pz, x1, z1, x2, z2) => {
  const dx = x2 - x1
  const dz = z2 - z1
  const L2 = dx * dx + dz * dz
  let t = 0
  if (L2 > 1e-12) {
    t = ((px - x1) * dx + (pz - z1) * dz) / L2
    t = t < 0 ? 0 : t > 1 ? 1 : t
  }
  const cx = x1 + dx * t - px
  const cz = z1 + dz * t - pz
  return Math.sqrt(cx * cx + cz * cz)
}

const readPlayerXZ = (driving, drivingAi) => {
  // While driving the on-foot Player is UNMOUNTED so window.__gtathensPlayer
  // is stale: prefer the DRIVEN car's live position — parked via the crash
  // module livePos CarDriver writes per frame (raw body translation as the
  // fallback), stolen AI cars via the ParkedCars hook's aiPos.
  try {
    if (drivingAi !== null && drivingAi !== undefined) {
      const g = window.__gtathensCars
      if (g && typeof g.aiPos === 'function') {
        const s = g.aiPos(drivingAi)
        if (s && Number.isFinite(s.x) && Number.isFinite(s.z)) return [s.x, s.z]
      }
    }
    if (driving !== null && driving !== undefined) {
      const g = window.__gtathensCars
      if (g && typeof g.pos === 'function') {
        const s = g.pos(driving)
        if (s && Number.isFinite(s.x) && Number.isFinite(s.z)) return [s.x, s.z]
      }
    }
    // On foot: Player.jsx writes this every physics frame.
    const p = window.__gtathensPlayer
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) return [p.x, p.z]
  } catch { /* seam not mounted yet */ }
  const st = useGameStore.getState()
  const sp = st.spawn
  if (Array.isArray(sp) && Number.isFinite(sp[0])) return [sp[0], sp[1] ?? 0]
  return null
}

const nearestStreet = (x, z) => {
  const cache = typeof window !== 'undefined' ? window.__gtathensRoadCache : null
  const segs = cache && cache.segs
  if (!segs || !segs.length) return null
  let best = null
  let bestD = Infinity
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i]
    // Bbox pre-filter before the sqrt test (same pattern as City.jsx).
    const need = STREET_RANGE_M + (s.w || 6) / 2
    if (Math.abs(x - (s.ax + s.bx) / 2) > need + Math.abs(s.bx - s.ax) / 2) continue
    if (Math.abs(z - (s.az + s.bz) / 2) > need + Math.abs(s.bz - s.az) / 2) continue
    const d = pointToSegmentDist(x, z, s.ax, s.az, s.bx, s.bz)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  if (!best || bestD > STREET_RANGE_M) return { name: 'Off-road', dist: bestD }
  return { name: streetLabelFor(best.type), dist: bestD }
}

const StreetHUD = () => {
  const phase = useGameStore((s) => s.phase)
  const driving = useGameStore((s) => s.driving)
  const drivingAi = useGameStore((s) => s.drivingAi)
  const [name, setName] = useState('Off-road')
  const nameRef = useRef(name)
  nameRef.current = name
  const posRef = useRef({ driving, drivingAi })
  posRef.current = { driving, drivingAi }

  useEffect(() => {
    if (phase !== Phase.PLAYING) return
    const timer = setInterval(() => {
      const xz = readPlayerXZ(posRef.current.driving, posRef.current.drivingAi)
      if (!xz) return
      const hit = nearestStreet(xz[0], xz[1])
      const next = hit ? hit.name : 'Off-road'
      if (next !== nameRef.current) setName(next)
    }, STREET_POLL_MS)
    return () => clearInterval(timer)
  }, [phase])

  if (phase !== Phase.PLAYING) return null

  return (
    <div className="hud-chip hud-street">
      <AnimatePresence mode="wait">
        <motion.span
          key={name}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {name}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}

export default StreetHUD
