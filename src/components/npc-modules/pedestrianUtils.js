import {
  buildingPolygons,
  buildSegments,
  DRIVABLE,
  hash01,
  pointInPolygon,
  roadPolyline,
  WALKABLE,
} from '../../lib/worldData'
import { PED_RADIUS } from './npcState'

export const buildPedSpawns = (data, spawn, count) => {
  const segs = []
  for (const road of data.roads || []) {
    if (!WALKABLE.has(road.type)) continue
    const pts = roadPolyline(road)
    for (let i = 0; i < pts.length - 1; i += 1) {
      const ax = pts[i][0]
      const az = pts[i][1]
      const bx = pts[i + 1][0]
      const bz = pts[i + 1][1]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 10 || len > 170) continue
      const mx = (ax + bx) / 2
      const mz = (az + bz) / 2
      if (Math.hypot(mx - spawn[0], mz - spawn[1]) > PED_RADIUS) continue
      segs.push([ax, az, bx, bz, len])
    }
  }
  if (segs.length === 0) {
    const drive = buildSegments(data, (t) => DRIVABLE.has(t))
    for (const s of drive) {
      const mx = (s.ax + s.bx) / 2
      const mz = (s.az + s.bz) / 2
      if (Math.hypot(mx - spawn[0], mz - spawn[1]) > PED_RADIUS) continue
      segs.push([s.ax, s.az, s.bx, s.bz, s.len])
    }
  }
  const polys = buildingPolygons(data)
  const out = []
  for (let k = 0; k < count; k += 1) {
    let placed = false
    for (let attempt = 0; attempt < 24 && !placed; attempt += 1) {
      if (segs.length === 0) break
      const seg = segs[Math.floor(hash01(k * 91 + attempt * 17) * segs.length) % segs.length]
      if (!seg) break
      const t = 0.1 + hash01(k * 13 + attempt * 7) * 0.8
      const px = seg[0] + (seg[2] - seg[0]) * t
      const pz = seg[1] + (seg[3] - seg[1]) * t
      if (Math.hypot(px - spawn[0], pz - spawn[1]) < 12) continue
      const side = hash01(k * 5 + attempt) > 0.5 ? 1 : -1
      const len = seg[4] || 1
      const x = px + ((seg[3] - seg[1]) / len) * 2.2 * side
      const z = pz + (-(seg[2] - seg[0]) / len) * 2.2 * side
      let inside = false
      for (const poly of polys) {
        if (pointInPolygon(x, z, poly)) { inside = true; break }
      }
      if (inside) continue
      out.push({ x, z })
      placed = true
    }
    if (!placed) out.push({ x: spawn[0] + 14 + k * 3, z: spawn[1] + 10 })
  }
  return out
}

export const setKb = (rb, x, y, z) => {
  try {
    rb.setNextKinematicTranslation({ x, y, z })
  } catch (e) {
    try { rb.setTranslation({ x, y, z }, true) } catch (e2) { /* noop */ }
  }
}
