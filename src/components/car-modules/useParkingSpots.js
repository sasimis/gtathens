
import { useEffect, useState } from 'react'
import { latToWorldZ, lonToWorldX } from '../../lib/geo'
import { CAR_IDS, LONG_IDS, PARK_COUNT, PARK_RADIUS } from './constants.js'
import { spotsCache } from './crashManager.js'
import { pointInPolygon, polyBBox } from './utils/polygon.js'
import { hash01, roadHeading } from './utils/misc.js'

export const useParkingSpots = (spawn = [0, 0], count = PARK_COUNT, radius = PARK_RADIUS) => {
  const key = `${Math.round(spawn[0] * 10)},${Math.round(spawn[1] * 10)},${count},${radius}`
  const [spots, setSpots] = useState(() => (spotsCache.key === key ? spotsCache.value : []))

  useEffect(() => {
    if (spotsCache.key === key) {
      setSpots(spotsCache.value)
      return
    }
    const ctrl = new AbortController()
    fetch('/map_data.json', { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data) => {
        const segs = []
        for (const road of data.roads || []) {
          const pts = (road.nodes || []).map((n) => [lonToWorldX(n.lon), latToWorldZ(n.lat)])
          if (pts.length < 2) continue
          for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1]
            const len = Math.hypot(b[0] - a[0], b[1] - a[1])
            if (len >= 12 && len <= 90) segs.push([a, b, len])
          }
        }
        segs.sort((s1, s2) => {
          const m1x = (s1[0][0] + s1[1][0]) / 2 - spawn[0]
          const m1z = (s1[0][1] + s1[1][1]) / 2 - spawn[1]
          const m2x = (s2[0][0] + s2[1][0]) / 2 - spawn[0]
          const m2z = (s2[0][1] + s2[1][1]) / 2 - spawn[1]
          return m1x * m1x + m1z * m1z - (m2x * m2x + m2z * m2z)
        })

        const buildings = (data.buildings || [])
          .map((b) => {
            const poly = (b.nodes || []).map((n) => [lonToWorldX(n.lon), latToWorldZ(n.lat)])
            if (poly.length < 3) return null
            return { poly, bbox: polyBBox(poly) }
          })
          .filter(Boolean)

        const out = []
        let k = 0
        for (const [a, b] of segs) {
          if (out.length >= count) break
          const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2
          if (Math.hypot(mx - spawn[0], mz - spawn[1]) > radius) break
          const t = 0.3 + hash01(k * 2 + 1) * 0.4
          const px = a[0] + (b[0] - a[0]) * t
          const pz = a[1] + (b[1] - a[1]) * t
          const heading = roadHeading(a, b)
          const side = k % 2 === 0 ? 1 : -1
          const ox = px + Math.cos(heading) * 3.2 * side
          const oz = pz - Math.sin(heading) * 3.2 * side
          if (Math.hypot(ox - spawn[0], oz - spawn[1]) < 7) { k++; continue }

          let inside = false
          for (const { poly, bbox } of buildings) {
            if (ox < bbox.minX || ox > bbox.maxX || oz < bbox.minZ || oz > bbox.maxZ) continue
            if (pointInPolygon(ox, oz, poly)) { inside = true; break }
          }
          if (inside) { k++; continue }

          let id = CAR_IDS[Math.floor(hash01(k) * (CAR_IDS.length - 5))]
          if (LONG_IDS.has(id) && out.length < 6) id = 'sedan'
          out.push({ id, position: [ox, 0.05, oz], rotation: heading + (side < 0 ? Math.PI : 0) })
          k++
        }
        spotsCache.key = key
        spotsCache.value = out
        if (!ctrl.signal.aborted) setSpots(out)
      })
      .catch((e) => { if (e.name !== 'AbortError') console.error('parking spots', e) })
    return () => ctrl.abort()
  }, [key])

  return spots
}
