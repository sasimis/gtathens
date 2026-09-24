// Street-name HUD: bottom-right chip showing the nearest street, on foot AND
// while driving — PLUS a GTA-style banner in the bottom-right corner (above
// the chip and the debug buttons) that pops whenever the street/area label
// CHANGES (fades after ~3 s). DOM overlay (mounted by MenuRoot next to Hud)
// — reads the published road-segment cache + stable QA traces, throttled to
// ~5 Hz, and animates in/out with framer-motion on change. Labels are REAL
// OSM road names + area (place=*) names only — never road-class strings
// like "Service Rd" (streetLabelFor returns null for unnamed ways; the
// fallback chain is road name -> area name -> 'Off-road').
//
// Position source: window.__gtathensPlayer (stable object Player.jsx writes
// every physics frame) on foot; the DRIVEN car's live body position while
// driving (the on-foot Player is unmounted then, so its trace is stale).
// No store writes, no re-renders of the 3D scene — useState only in this chip.
import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import useGameStore, { Phase } from '../store/useGameStore'
import { streetLabelFor } from '../components/Roads'
import { areaLabels, areaLabelAt, loadWorldData } from '../lib/worldData'

// Local point-to-segment distance (numbers only, no alloc). Duplicated from
// City.jsx's planBuildings helper on purpose: importing City.jsx from a DOM
// overlay module would drag drei/Rapier into the HUD bundle AND create a
// City <-> overlay import cycle. Keep the two copies in sync (both are the
// standard projection-clamped distance).

const STREET_POLL_MS = 300 // same cadence as the car enter-detection poll
const STREET_RANGE_M = 25 // beyond this we are off-road
const STREET_BANNER_MS = 3200 // street-change banner visible time

// ALL-CAPS WITHOUT Greek tones: CSS text-transform keeps the tonos (accent)
// on capital Greek letters, which looks wrong — Greek caps are written
// plain. Uppercase first, then strip the combining marks NFD exposes
// (tonos U+0301, dialytika U+0308, ...). Applied ONLY to the banner label;
// the chip keeps natural mixed case.
const bannerCase = (s) =>
  s.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')

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
  if (!best || bestD > STREET_RANGE_M) return { name: null, dist: bestD }
  // Real OSM street name, or null for unnamed ways — NO road-class labels
  // ("Service Rd"/"Link" are banned; resolveLabel falls back to the area name).
  return { name: streetLabelFor(best), dist: bestD }
}

const StreetHUD = () => {
  const phase = useGameStore((s) => s.phase)
  const driving = useGameStore((s) => s.driving)
  const drivingAi = useGameStore((s) => s.drivingAi)
  const [name, setName] = useState('Off-road')
  // Street-change banner: pops bottom-right on every label change, fades
  // after STREET_BANNER_MS. `bannerKey` re-triggers the framer-motion
  // enter/exit animation for repeats of the same name (out-and-back trips).
  const [banner, setBanner] = useState(null)
  const [bannerKey, setBannerKey] = useState(0)
  const nameRef = useRef(name)
  nameRef.current = name
  const posRef = useRef({ driving, drivingAi })
  posRef.current = { driving, drivingAi }
  const bannerTimer = useRef(null)
  // OSM area labels (place=*) — loaded ONCE with the shared world data before
  // polling starts, so the first resolve already sees them (no placeholder
  // flash-banner at spawn). Fail soft: road names still work without them.
  const areasRef = useRef([])
  // The FIRST observation only seeds the chip (spawn/resume) — the banner
  // waits for a real change after that.
  const seededRef = useRef(false)

  // Road name when on a named street -> else the OSM area we stand in ->
  // else 'Off-road'. Road names + area names ONLY (user rule: no generic
  // class labels like "Residential St"/"Service Rd").
  const resolveLabel = (x, z) => {
    const hit = nearestStreet(x, z)
    if (hit && hit.name) return hit.name
    const area = areaLabelAt(areasRef.current, x, z)
    return area || 'Off-road'
  }

  useEffect(() => {
    if (phase !== Phase.PLAYING) return
    let cancelled = false
    let timer = null
    const startPolling = () => {
      if (cancelled || timer) return
      timer = setInterval(() => {
        const xz = readPlayerXZ(posRef.current.driving, posRef.current.drivingAi)
        if (!xz) return
        const next = resolveLabel(xz[0], xz[1])
        const first = !seededRef.current
        if (first) seededRef.current = true
        if (next === nameRef.current) return
        setName(next)
        if (first) return // first observation only fills the chip — no banner
        setBanner(next)
        setBannerKey((k) => k + 1)
        if (bannerTimer.current) clearTimeout(bannerTimer.current)
        bannerTimer.current = setTimeout(() => setBanner(null), STREET_BANNER_MS)
      }, STREET_POLL_MS)
    }
    // Areas ride the shared one-fetch worldData cache (NPCs/pickups usually
    // populated it before PLAYING; this is then one microtask).
    loadWorldData()
      .then((data) => {
        if (!cancelled) areasRef.current = areaLabels(data)
      })
      .catch(() => { /* no areas — road names still work */ })
      .finally(startPolling)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      if (bannerTimer.current) clearTimeout(bannerTimer.current)
    }
  }, [phase])

  if (phase !== Phase.PLAYING) return null

  return (
    <>
      <div className="hud-chip hud-street" title={name}>
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
      {/* GTA-style street-change banner: bottom-right, above chip + debug buttons */}
      <AnimatePresence>
        {banner && (
          <motion.div
            key={bannerKey}
            className="street-banner"
            initial={{ y: 26, opacity: 0, scale: 0.96 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 10, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <span className="street-banner-label">{bannerCase(banner)}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

export default StreetHUD
