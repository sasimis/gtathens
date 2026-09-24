import React, { useMemo } from 'react'
import * as THREE from 'three'
import { latToWorldZ, lonToWorldX } from '../lib/geo'

/**
 * Renders OSM roads as flat ribbon meshes, merged into one BufferGeometry
 * per class bucket (one draw call per bucket). y offsets keep overlaps
 * (intersections) free of z-fighting.
 */

/**
 * Painted carriageway width (m) for an OSM road type. Single source of
 * truth — shared by the ribbon builder, the drivable-segment publisher,
 * City.jsx's building-vs-road rejection, and the street-name HUD so every
 * system agrees on how wide a street is. Unknown types fall back to 6 m.
 */
export const roadWidthFor = (type) => ROAD_STYLE[type]?.w ?? 6

/**
 * Real OSM street name for a road segment (or a whole road object): the
 * `name` tag when the way has one (map_data.json carries it — see
 * parse_map.py), `null` otherwise. NO road-class fallback ("Service Rd",
 * "Primary Link", ...) — StreetHUD shows road names + area names only
 * (area fallback: lib/worldData.areaLabels).
 */
export const streetLabelFor = (typeOrRoad) => {
  const name = typeof typeOrRoad === 'object' && typeOrRoad !== null ? typeOrRoad.name : null
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

const ROAD_STYLE = {
  motorway: { w: 16, bucket: 'major' },
  motorway_link: { w: 8, bucket: 'major' },
  trunk: { w: 14, bucket: 'major' },
  trunk_link: { w: 8, bucket: 'major' },
  primary: { w: 12, bucket: 'major' },
  primary_link: { w: 7, bucket: 'major' },
  secondary: { w: 9, bucket: 'major' },
  secondary_link: { w: 6, bucket: 'major' },
  tertiary: { w: 8, bucket: 'minor' },
  residential: { w: 6, bucket: 'minor' },
  unclassified: { w: 6, bucket: 'minor' },
  living_street: { w: 5.5, bucket: 'minor' },
  service: { w: 4.5, bucket: 'minor' },
  pedestrian: { w: 5, bucket: 'minor' },
  footway: { w: 2.2, bucket: 'path' },
  path: { w: 2, bucket: 'path' },
  track: { w: 3, bucket: 'path' },
  cycleway: { w: 2.2, bucket: 'path' },
}

const BUCKETS = [
  { key: 'path', y: 0.03, color: '#8d8672', fallbackW: 2.2 },
  { key: 'minor', y: 0.045, color: '#4b4e55', fallbackW: 5.5 },
  { key: 'major', y: 0.06, color: '#3a3d43', fallbackW: 10 },
]

/**
 * Publish the DRIVABLE road segments (world-space line segments + their width)
 * into `window.__gtathensRoadCache` for the driving surface model
 * (car-modules/crashManager.js `isOnAsphalt`): asphalt = full grip/top speed,
 * anything else = 0.55x (off-road drag). Footways/paths are skipped on purpose
 * — a 2 m footway is not a drivable surface, so counting it would hand cars
 * full speed on the pavement.
 *
 * One flat array of stable {ax, az, bx, bz, w, type, name} objects, built ONCE
 * per road data load; the consumer does a throttled point-segment test, so
 * nothing here runs per frame. `name` is the real OSM street name when the
 * way has one (see parse_map.py); unnamed ways carry name:null — the HUD
 * falls back to the area label (no road-class strings).
 */
export const publishRoadSegments = (roads) => {
  const segs = []
  for (const road of roads || []) {
    const style = ROAD_STYLE[road.type]
    if (!style || style.bucket === 'path') continue
    const w = style.w ?? 6
    for (let i = 0; i < (road.nodes || []).length - 1; i++) {
      const a = road.nodes[i]
      const b = road.nodes[i + 1]
      const ax = lonToWorldX(a.lon)
      const az = latToWorldZ(a.lat)
      const bx = lonToWorldX(b.lon)
      const bz = latToWorldZ(b.lat)
      // Skip zero-length stubs (they'd make a degenerate point-segment test).
      if (Math.abs(bx - ax) < 1e-6 && Math.abs(bz - az) < 1e-6) continue
      // `type` + `name` ride along so the street-name HUD can label the
      // nearest segment without a second OSM walk. `name` is the real OSM
      // street name when the way has one (see parse_map.py); unnamed ways
      // carry name:null — the HUD falls back to the area label, never to a
      // road-class string.
      segs.push({ ax, az, bx, bz, w, type: road.type, name: road.name ?? null })
    }
  }
  if (typeof window !== 'undefined') window.__gtathensRoadCache = { segs }
  return segs.length
}

const buildRoadGeometry = (roads, bucket, fallbackW) => {
  const positions = []
  const normals = []
  for (const road of roads) {
    const style = ROAD_STYLE[road.type]
    if (!style || style.bucket !== bucket) continue
    const halfW = (style?.w ?? fallbackW) / 2
    for (let i = 0; i < road.nodes.length - 1; i++) {
      const a = road.nodes[i]
      const b = road.nodes[i + 1]
      const ax = lonToWorldX(a.lon)
      const az = latToWorldZ(a.lat)
      const bx = lonToWorldX(b.lon)
      const bz = latToWorldZ(b.lat)
      const dx = bx - ax
      const dz = bz - az
      const len = Math.hypot(dx, dz)
      if (len < 0.05) continue
      // Perpendicular unit vector scaled to half width
      const nx = (-dz / len) * halfW
      const nz = (dx / len) * halfW
      // Two triangles per segment (winding fixed by DoubleSide + manual normals)
      positions.push(
        ax - nx, 0, az - nz, ax + nx, 0, az + nz, bx + nx, 0, bz + nz,
        ax - nx, 0, az - nz, bx + nx, 0, bz + nz, bx - nx, 0, bz - nz,
      )
      for (let k = 0; k < 6; k++) normals.push(0, 1, 0)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  return geometry
}

const Roads = ({ roads }) => {
  const geometries = useMemo(
    () => BUCKETS.map((b) => buildRoadGeometry(roads, b.key, b.fallbackW)),
    [roads],
  )
  // Publish the drivable segment cache with the same data the ribbons are built
  // from, so the driving surface model always matches the VISIBLE asphalt.
  useMemo(() => publishRoadSegments(roads), [roads])

  return (
    <>
      {BUCKETS.map((bucket, i) => (
        <mesh
          key={bucket.key}
          geometry={geometries[i]}
          position={[0, bucket.y, 0]}
          receiveShadow
        >
          <meshStandardMaterial
            color={bucket.color}
            roughness={0.95}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </>
  )
}

export default Roads
