// Pedestrian navmesh — the WALKING half of the navigation story.
//
// Mounts (null-rendered) inside the <Canvas>, builds ONE navmesh tile for the
// playable area (ground + building prisms from the real OSM footprints), and
// publishes a query the peds' wander steering reads through `navRuntime`.
// Cars NEVER use this — they route on the road graph (lib/RoadPathfinder.js),
// which is exactly how GTA does it: navmesh for people, road splines for
// traffic.
//
// Build path and every unit decision were proven headlessly first —
// `node scripts/navmesh-repro.mjs` runs THIS module (not a copy) in Node:
//   T2/T3 walkableRadius/Height are VOXELS (navConfig does the conversion)
//   T4/T5 building prisms carve the mesh; interiors are NOT walkable islands
//        (pushPrism's floorCap) — a bad seed once nuked the whole city
//   T6 city-scale tile: ~440 ms one-time, queries ~1 ms
//   T7 a Crowd walks agents along the mesh with zero per-frame allocations
//
// Failure posture: if the wasm build fails, navRuntime stays `ready: false`
// and every ped silently falls back to its old random-yaw wander — the game
// keeps running, just with dumber peds. Nothing here can block play.
import React, { useEffect } from 'react'
import { loadWorldData, buildingPolygons } from '../lib/worldData'
import {
  NAV_DEFAULTS,
  buildNavGeometry,
  buildNavMesh,
  createNavQuery,
  ensureNavReady,
  navConfig,
  navMeshPolyCount,
  navNearest,
  navPath,
  navRandomPointAround,
} from '../lib/navmesh'

/**
 * Module-level runtime — read by Ped (Npcs.jsx) per frame, so it MUST be a
 * stable object mutated in place (never reassigned). Peds only ever touch it
 * through `navRuntime.ready` + the query, so a null component tree never
 * dangles: the fields simply stay falsy.
 */
export const navRuntime = {
  ready: false,
  query: null,
  navMesh: null,
  polys: 0,
  ms: 0,
  prisms: 0,
  /** Busy-guard: a second build while one is in flight would double the wasm. */
  building: false,
}

/** Nominal building height for the prisms. Any h >= ~3 carves the same block:
    the mesh only cares that headroom under the walls is unwalkable. */
const BUILDING_NAV_H = 6

const CityNavMesh = ({ center = [0, 0] }) => {
  const ck = `${Math.round(center[0])},${Math.round(center[1])}`
  useEffect(() => {
    if (navRuntime.building || navRuntime.ready) return undefined
    let cancelled = false
    navRuntime.building = true
    ;(async () => {
      // Both must resolve: wasm for the generator, data for the footprints.
      const [data] = await Promise.all([loadWorldData(), ensureNavReady()])
      if (cancelled || !data) return
      const buildings = buildingPolygons(data).map((ring) => ({ outline: ring, colH: BUILDING_NAV_H }))
      const geom = buildNavGeometry({ center, buildings })
      const built = buildNavMesh(geom, navConfig())
      if (cancelled || !built.success) return
      navRuntime.navMesh = built.navMesh
      navRuntime.query = createNavQuery(built.navMesh)
      navRuntime.prisms = geom.prisms
      navRuntime.polys = navMeshPolyCount(built.navMesh)
      navRuntime.ms = built.ms
      navRuntime.ready = true
    })().catch(() => {
      /* navRuntime stays ready:false — peds fall back to blind wander */
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ck])
  return null
}

/**
 * QA seam (scripts/smoke.mjs). Stable module-scope object; every method
 * returns plain numbers and no-ops to null/false until the mesh is ready.
 */
export const navQA = {
  ready: () => navRuntime.ready,
  polys: () => navRuntime.polys,
  ms: () => navRuntime.ms,
  prisms: () => navRuntime.prisms,
  /** Is (x, z) on walkable mesh? (the T5 interior check, live) */
  walkable: (x, z) => {
    if (!navRuntime.ready) return null
    return !!navNearest(navRuntime.query, x, z)
  },
  /** A wander target, exactly what Ped asks for. */
  wander: (x, z, radius, seed) => {
    if (!navRuntime.ready) return null
    return navRandomPointAround(navRuntime.query, x, z, radius, seed)
  },
  /** A routed path between two points ([[x,z],...]), or null. */
  path: (ax, az, bx, bz) => {
    if (!navRuntime.ready) return null
    const r = navPath(navRuntime.query, [ax, az], [bx, bz])
    return r.found ? r.points : null
  },
}
if (typeof window !== 'undefined') window.__gtathensNav = navQA

export default CityNavMesh
