
import React, { useEffect, useMemo } from 'react'
import { useFBX } from '@react-three/drei'
import useGameStore from '../../store/useGameStore'
import { crash, isOnAsphalt } from './crashManager.js'
import { HALF, PARK_COUNT, PARK_RADIUS } from './constants.js'
import { Car } from './Car.jsx'
import { CarDriver, LooseSettler } from './CarDriver.jsx'
import { useParkingSpots } from './useParkingSpots.js'
import { normalizeId, CAR_IDS_SET } from './utils/misc.js'

export const ParkedCars = ({ spawn = [0, 0], count = PARK_COUNT, radius = PARK_RADIUS }) => {
  const spots = useParkingSpots(spawn, count, radius)
  const driving = useGameStore((s) => s.driving)

  // stable ref holders per spot — grow in place, never recreated, so Rapier
  // body refs survive spot-list refreshes and fast remounts.
  const carRefs = useMemo(() => [], [])
  while (carRefs.length < spots.length) {
    carRefs.push({ body: { current: null }, model: { current: null } })
  }

  // lazy preload only models we actually use
  useEffect(() => {
    const used = new Set(spots.map((s) => s.id))
    used.forEach((id) => {
      if (CAR_IDS_SET.has(id)) useFBX.preload(`/models/cars/${id}.fbx`)
    })
  }, [spots])

  // Headless QA seam (scripts/smoke.mjs): parked-car probe. Always installed
  // (smoke.mjs attaches to a release build too, where DEV is false), but the
  // methods only run when a test calls them — zero cost during play.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const hook = {
      count: () => spots.length,
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
        const s = spots[i]
        if (!s) return null
        const lp = crash.livePos[i]
        return { x: lp ? lp.x : s.position[0], z: lp ? lp.z : s.position[2], rot: s.rotation }
      },
      // Raw Rapier body type per parked car, as a number:
      // 0 = dynamic, 1 = fixed, 2 = kinematicPosition, 3 = kinematicVelocity.
      // A parked car MUST be 1 (fixed) unless it is the driven one (0) — this
      // is the probe that proves `type="fixed"` actually landed, and it is also
      // how the enum-vs-string trap in crashManager.setRigidBodyType was found
      // (rb.setBodyType('fixed') coerces to 0 = Dynamic).
      btype: (i) => {
        const rb = crash.bodies[i]
        if (!rb || typeof rb.bodyType !== 'function') return null
        try {
          return rb.bodyType()
        } catch (e) {
          return null
        }
      },
      // Road-surface probe: how many drivable segments Roads.jsx published, and
      // whether a given point is on asphalt (full grip) or off-road (0.55x).
      // Guards the "asphalt cache is never published -> every car crawls at
      // grass speed" bug class.
      roadSegs: () => (window.__gtathensRoadCache?.segs?.length ?? 0),
      asphalt: (x, z) => isOnAsphalt(x, z),
      // Street-name HUD probe: live XZ of a stolen AI car (StreetHUD reads
      // this while drivingAi is set — the on-foot trace is stale then).
      aiPos: (i) => {
        const live = crash.aiLive[i]
        if (live && Number.isFinite(live.x)) return { x: live.x, z: live.z }
        const rb = crash.aiBodies[i]
        if (!rb || typeof rb.translation !== 'function') return null
        try {
          const t = rb.translation()
          return { x: t.x, z: t.z }
        } catch { return null }
      },
      ram: (tIdx) => {
        if (!spots.length) return null
        const j = ((tIdx % spots.length) + spots.length) % spots.length
        const driving = useGameStore.getState().driving
        const mine = driving != null ? crash.bodies[driving] : null
        const target = hook.spot(j)
        if (!mine || !target) return null
        const hx = Math.sin(target.rot)
        const hz = Math.cos(target.rot)
        const t = mine.translation()
        mine.setTranslation({ x: target.x - hx * 6.5, y: t.y, z: target.z - hz * 6.5 }, true)
        mine.setLinvel({ x: 0, y: 0, z: 0 }, true)
        mine.setAngvel({ x: 0, y: 0, z: 0 }, true)
        const c = Math.cos(target.rot / 2)
        const s = Math.sin(target.rot / 2)
        mine.setRotation({ x: 0, y: s, z: 0, w: c }, true)
        return { target: j, x: target.x - hx * 6.5, z: target.z - hz * 6.5 }
      },
    }
    window.__gtathensCars = hook
    return () => {
      if (window.__gtathensCars === hook) delete window.__gtathensCars
    }
  }, [spots])

  return (
    <>
      {spots.map((s, i) => (
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
      {driving != null && driving < spots.length && (
        <CarDriver
          bodyRef={carRefs[driving].body}
          modelRef={carRefs[driving].model}
          spotIndex={driving}
          half={HALF[normalizeId(spots[driving].id)]}
          carId={spots[driving].id}
        />
      )}
    </>
  )
}
