import React, { useEffect, useMemo, useState } from 'react'
import { Merged, useGLTF } from '@react-three/drei'
import { ConvexHullCollider, RigidBody, TrimeshCollider } from '@react-three/rapier'
import * as THREE from 'three'
import Roads from './Roads'
import { roadWidthFor } from './Roads'
import useGameStore from '../store/useGameStore'
import { latToWorldZ, lonToWorldX } from '../lib/geo'

// Collision groups (Rapier): bits 0-15 = membership, bits 16-31 = filter.
const GROUP_BUILDING = 0x0008
const BUILDING_COLLISION_GROUPS = GROUP_BUILDING | (0x000F << 16) // buildings collide with all

/* ------------------------------------------------------------------ */
/* Kenney City Kit model pools (CC0, downloaded from kenney.nl)        */
/* ------------------------------------------------------------------ */

const letters = 'abcdefghijklmnopqrstuvwx'.split('')

// City Kit (Commercial): office blocks + skyscrapers
const COMMERCIAL_MODELS = [
  ...letters.slice(0, 14).map((l) => `commercial/building-${l}`),
  ...letters.slice(0, 5).map((l) => `commercial/building-skyscraper-${l}`),
]
const SKYSCRAPER_MODELS = COMMERCIAL_MODELS.slice(14)
const SUBURBAN_MODELS = letters.slice(0, 21).map((l) => `suburban/building-type-${l}`)
const INDUSTRIAL_MODELS = letters.slice(0, 20).map((l) => `industrial/building-${l}`)

const MODEL_IDS = [...COMMERCIAL_MODELS, ...SUBURBAN_MODELS, ...INDUSTRIAL_MODELS]
const MODEL_URLS = MODEL_IDS.map((id) => `/models/kenney/${id}.glb`)
MODEL_URLS.forEach((url) => useGLTF.preload(url))

const POOLS = {
  commercial: COMMERCIAL_MODELS,
  suburban: SUBURBAN_MODELS,
  industrial: INDUSTRIAL_MODELS,
}

// Deterministic per-index pseudo-random in [0, 1)
const hash = (i) => {
  let h = (i * 2654435761) >>> 0
  h ^= h >>> 13
  h = (h * 1274126177) >>> 0
  return h / 4294967295
}

const CATEGORY_DEFAULT_HEIGHT = {
  commercial: 15,
  civic: 12,
  mixed: 11,
  residential: 8.5,
  industrial: 7.5,
}

const clamp = (v, min, max) => Math.min(Math.max(v, min), max)

const DECORATION_RE = /^(bush|plant|tree|hedge|flower|planter|shrub|fence|bench|light|lamppost|sign)/i
const TINY_CLUTTER_EW = 1.6
const TINY_CLUTTER_EH = 1.2

const xzHull = (points) => {
  const seen = new Set()
  const pts = []
  for (const p of points) {
    const key = `${p[0].toFixed(3)},${p[1].toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    pts.push(p)
  }
  if (pts.length < 3) return null
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (P) => {
    const st = []
    for (const p of P) {
      while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], p) <= 1e-9) st.pop()
      st.push(p)
    }
    return st
  }
  const lo = half(pts)
  const up = []
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i]
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 1e-9) up.pop()
    up.push(p)
  }
  lo.pop()
  up.pop()
  const hull = lo.concat(up)
  if (hull.length < 3) return null
  const SIN_MIN = Math.sin((10 * Math.PI) / 180)
  const simple = []
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[(i + hull.length - 1) % hull.length]
    const b = hull[i]
    const c = hull[(i + 1) % hull.length]
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1])
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1])
    if (l1 * l2 < 1e-9) continue
    if (Math.abs(cross(a, b, c)) / (l1 * l2) < SIN_MIN) continue
    simple.push(b)
  }
  return simple.length >= 3 ? simple : hull
}

const pickPoolId = (category, area) => {
  if (category === 'industrial') return 'industrial'
  if (category === 'residential') return area < 350 ? 'suburban' : 'commercial'
  if (category === 'mixed' && area < 120) return 'suburban'
  return 'commercial'
}

let kenneyCache = null

const buildKenneyCache = (scenes) => {
  const meshMap = {}
  const byModel = {}
  const xzPts = []
  const tmpV = new THREE.Vector3()
  MODEL_IDS.forEach((id, i) => {
    const scene = scenes[i]
    scene.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(scene)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const keys = []
    let n = 0
    xzPts.length = 0
    scene.traverse((obj) => {
      if (obj.isMesh) {
        const originalName = (obj.name || '').trim()
        if (!obj.userData.kenneyKey) {
          obj.userData.kenneyKey = `${id}__${originalName || n++}`
        }
        const key = obj.userData.kenneyKey
        obj.name = key
        if (!keys.includes(key)) keys.push(key)
        if (!meshMap[key]) meshMap[key] = obj
        if (posCandidate(obj, originalName, size, center)) {
          const pos = obj.geometry.getAttribute('position')
          if (pos) {
            for (let vi = 0; vi < pos.count; vi += 1) {
              tmpV.fromBufferAttribute(pos, vi).applyMatrix4(obj.matrixWorld)
              xzPts.push([tmpV.x, tmpV.z])
            }
          }
        }
      }
    })
    byModel[id] = {
      keys,
      w: Math.max(size.x, 0.01),
      h: Math.max(size.y, 0.01),
      d: Math.max(size.z, 0.01),
      cx: center.x,
      cz: center.z,
      minY: box.min.y,
      footprint: xzHull(xzPts),
    }
  })
  return { meshMap, byModel }
}

const posCandidate = (obj, originalName, modelSize, modelCenter) => {
  if (DECORATION_RE.test(originalName)) return false
  const pos = obj.geometry.getAttribute('position')
  if (!pos) return true
  const local = new THREE.Vector3()
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let vi = 0; vi < pos.count; vi += 1) {
    local.fromBufferAttribute(pos, vi).applyMatrix4(obj.matrixWorld)
    if (local.x < minX) minX = local.x
    if (local.x > maxX) maxX = local.x
    if (local.y < minY) minY = local.y
    if (local.y > maxY) maxY = local.y
    if (local.z < minZ) minZ = local.z
    if (local.z > maxZ) maxZ = local.z
  }
  const ew = Math.max(maxX - minX, 0.01)
  const eh = Math.max(maxY - minY, 0.01)
  const ed = Math.max(maxZ - minZ, 0.01)
  if (ew < TINY_CLUTTER_EW && eh < TINY_CLUTTER_EH && ed < TINY_CLUTTER_EW) return false
  return true
}

const useKenneyMeshes = () => {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const scenes = MODEL_IDS.map((id) => useGLTF(`/models/kenney/${id}.glb`).scene)
  if (!kenneyCache) kenneyCache = buildKenneyCache(scenes)
  return kenneyCache
}

const ROAD_CLEAR_M = 2
const OUTLINE_ROAD_MARGIN = 2

const pointToSegmentDistSq = (px, pz, x1, z1, x2, z2) => {
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
  return cx * cx + cz * cz
}

export const pointToSegmentDist = (px, pz, x1, z1, x2, z2) =>
  Math.sqrt(pointToSegmentDistSq(px, pz, x1, z1, x2, z2))

const planBuildings = (data, byModel) => {
  const roadSegs = []
  let maxHalfW = 0
  for (const road of data.roads || []) {
    const halfW = roadWidthFor(road.type) / 2
    if (halfW > maxHalfW) maxHalfW = halfW
    const nodes = road.nodes || []
    for (let k = 0; k < nodes.length - 1; k += 1) {
      const x1 = lonToWorldX(nodes[k].lon)
      const z1 = latToWorldZ(nodes[k].lat)
      const x2 = lonToWorldX(nodes[k + 1].lon)
      const z2 = latToWorldZ(nodes[k + 1].lat)
      if (Math.abs(x2 - x1) < 1e-6 && Math.abs(z2 - z1) < 1e-6) continue
      roadSegs.push({ x1, z1, x2, z2, halfW })
    }
  }

  return data.buildings.flatMap((b, i) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
    const outline = []
    for (const n of b.nodes) {
      const px = lonToWorldX(n.lon)
      const pz = latToWorldZ(n.lat)
      outline.push([px, pz])
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (pz < minZ) minZ = pz
      if (pz > maxZ) maxZ = pz
    }
    const w = maxX - minX
    const d = maxZ - minZ
    if (w < 4 || d < 4 || w > 220 || d > 220) return []

    const x = (minX + maxX) / 2
    const z = (minZ + maxZ) / 2
    const area = w * d

    if (roadSegs.length > 0) {
      let onRoad = false
      for (let s = 0; s < roadSegs.length; s += 1) {
        const seg = roadSegs[s]
        const need = seg.halfW + ROAD_CLEAR_M
        if (Math.abs(x - (seg.x1 + seg.x2) / 2) > need + Math.abs(seg.x2 - seg.x1) / 2) continue
        if (Math.abs(z - (seg.z1 + seg.z2) / 2) > need + Math.abs(seg.z2 - seg.z1) / 2) continue
        if (pointToSegmentDistSq(x, z, seg.x1, seg.z1, seg.x2, seg.z2) < need * need) {
          onRoad = true
          break
        }
      }
      if (onRoad) return []
      for (let s = 0; s < roadSegs.length && !onRoad; s += 1) {
        const seg = roadSegs[s]
        const need = seg.halfW + OUTLINE_ROAD_MARGIN
        const needSq = need * need
        for (let c = 0; c < outline.length; c += 1) {
          const corner = outline[c]
          if (pointToSegmentDistSq(corner[0], corner[1], seg.x1, seg.z1, seg.x2, seg.z2) < needSq) {
            onRoad = true
            break
          }
        }
      }
      if (onRoad) return []
    }

    let h
    if (b.height) h = b.height
    else if (b.levels) h = b.levels * 3.2
    else h = CATEGORY_DEFAULT_HEIGHT[b.category] * (0.7 + hash(i) * 0.6)
    h = clamp(h, 4, 120)

    const poolId = pickPoolId(b.category, area)
    let model
    if (poolId === 'commercial' && h >= 55) {
      model = SKYSCRAPER_MODELS[Math.floor(hash(i + 7) * SKYSCRAPER_MODELS.length)]
    } else {
      const pool = POOLS[poolId]
      model = pool[Math.floor(hash(i) * pool.length)]
    }
    const meta = byModel[model]

    const sx = (w * 0.94) / meta.w
    const sz = (d * 0.94) / meta.d
    const avgXZ = (sx + sz) / 2
    const sy = clamp(h / meta.h, avgXZ * 0.4, avgXZ * 4)

    const footprintLongX = w >= d
    const modelLongX = meta.w >= meta.d
    const rot = (footprintLongX ? 0 : Math.PI / 2) + (footprintLongX === modelLongX ? 0 : Math.PI / 2)

    let footprint = null
    if (meta.footprint && meta.footprint.length >= 3) {
      const cos = Math.cos(rot)
      const sin = Math.sin(rot)
      footprint = meta.footprint.map(([mx, mz]) => {
        const wx = mx * sx
        const wz = mz * sz
        return [x + wx * cos + wz * sin, z - wx * sin + wz * cos]
      })
    }

    return [{
      x,
      z,
      y0: -meta.minY * sy,
      rot,
      sx,
      sy,
      sz,
      w,
      d,
      h,
      colH: meta.h * sy,
      model,
      footprint,
      outline,
    }]
  })
}

const isConvexRing = (ring) => {
  const n = ring.length
  if (n < 3) return true
  let sign = 0
  for (let i = 0; i < n; i += 1) {
    const a = ring[(i + n - 1) % n]
    const b = ring[i]
    const c = ring[(i + 1) % n]
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (Math.abs(cross) < 1e-9) return false
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

const triangulateEarclip = (ring) => {
  const pts = ring.map((p) => [p[0], p[1]])
  const n = pts.length
  const idx = new Array(n)
  for (let i = 0; i < n; i += 1) idx[i] = i
  const out = []
  let again = true
  while (again && idx.length > 3) {
    again = false
    for (let k = 0; k < idx.length; k += 1) {
      const i0 = idx[(k + idx.length - 1) % idx.length]
      const i1 = idx[k]
      const i2 = idx[(k + 1) % idx.length]
      const ax = pts[i1][0] - pts[i0][0]
      const ay = pts[i1][1] - pts[i0][1]
      const bx = pts[i2][0] - pts[i1][0]
      const by = pts[i2][1] - pts[i1][1]
      const cross = ax * by - ay * bx
      if (Math.abs(cross) < 1e-9) continue
      const areaSign = Math.sign(cross)
      let ok = true
      for (let j = 0; j < idx.length; j += 1) {
        if (j === k || j === (k + 1) % idx.length) continue
        const p = pts[idx[j]]
        if (pointInTriangle(p, pts[i0], pts[i1], pts[i2], areaSign)) {
          ok = false
          break
        }
      }
      if (!ok) continue
      out.push([i0, i1, i2])
      idx.splice(k, 1)
      again = true
      break
    }
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]])
  return out
}

const pointInTriangle = (p, a, b, c, areaSign) => {
  const v0x = c[0] - a[0], v0y = c[1] - a[1]
  const v1x = b[0] - a[0], v1y = b[1] - a[1]
  const v2x = p[0] - a[0], v2y = p[1] - a[1]
  const dot00 = v0x * v0x + v0y * v0y
  const dot01 = v0x * v1x + v0y * v1y
  const dot02 = v0x * v2x + v0y * v2y
  const dot11 = v1x * v1x + v1y * v1y
  const dot12 = v1x * v2x + v1y * v2y
  const inv = dot00 * dot11 - dot01 * dot01
  if (Math.abs(inv) < 1e-12) return false
  const u = (dot11 * dot02 - dot01 * dot12) / inv
  const v = (dot00 * dot12 - dot01 * dot02) / inv
  return u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9
}

const hullVerts = (b) => {
  const h = Math.max(b.colH || b.h || 4, 0.5)
  const ring = []
  for (const [px, pz] of b.footprint || b.outline || []) {
    const lx = px - b.x
    const lz = pz - b.z
    if (!Number.isFinite(lx) || !Number.isFinite(lz)) continue
    const last = ring[ring.length - 1]
    if (last && Math.abs(last[0] - lx) < 1e-3 && Math.abs(last[1] - lz) < 1e-3) continue
    ring.push([lx, lz])
  }
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (ring.length > 1 && Math.abs(first[0] - last[0]) < 1e-3 && Math.abs(first[1] - last[1]) < 1e-3) {
    ring.pop()
  }

  let area2 = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]
    const c = ring[(i + 1) % ring.length]
    area2 += a[0] * c[1] - c[0] * a[1]
  }
  const usable = ring.length >= 3 && Math.abs(area2) * 0.5 > 0.5
  const hw = Math.max(b.w, 1) / 2
  const hd = Math.max(b.d, 1) / 2
  const base = usable ? ring : [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]

  const concave = usable && !isConvexRing(base)
  if (concave) {
    const tris = triangulateEarclip(base)
    if (tris.length >= 1) {
      const vertCount = tris.length * 6
      const verts = new Float32Array(vertCount * 3)
      let k = 0
      for (const [i0, i1, i2] of tris) {
        const b0 = base[i0], b1 = base[i1], b2 = base[i2]
        for (const [lx, lz] of [b0, b1, b2]) {
          verts[k] = lx; verts[k + 1] = 0; verts[k + 2] = lz; k += 3
        }
        for (const [lx, lz] of [b0, b1, b2]) {
          verts[k] = lx; verts[k + 1] = h; verts[k + 2] = lz; k += 3
        }
      }
      const idxCount = tris.length * 12
      const indices = new Int16Array(idxCount)
      let ik = 0
      for (let t = 0; t < tris.length; t += 1) {
        const baseIdx = t * 6
        const b0 = baseIdx, b1 = baseIdx + 1, b2 = baseIdx + 2
        const t0 = baseIdx + 3, t1 = baseIdx + 4, t2 = baseIdx + 5
        indices[ik] = b0; indices[ik + 1] = b1; indices[ik + 2] = b2; ik += 3
        indices[ik] = t0; indices[ik + 1] = t2; indices[ik + 2] = t1; ik += 3
        indices[ik] = b0; indices[ik + 1] = b1; indices[ik + 2] = t1; ik += 3
        indices[ik] = b0; indices[ik + 1] = t1; indices[ik + 2] = t0; ik += 3

        indices[ik] = b1; indices[ik + 1] = b2; indices[ik + 2] = t2; ik += 3
        indices[ik] = b1; indices[ik + 1] = t2; indices[ik + 2] = t1; ik += 3

        indices[ik] = b2; indices[ik + 1] = b0; indices[ik + 2] = t0; ik += 3
        indices[ik] = b2; indices[ik + 1] = t0; indices[ik + 2] = t2; ik += 3
      }
      return { verts, indices, kind: 'trimesh' }
    }
  }

  const flat = new Float32Array(base.length * 6)
  let k = 0
  for (const [lx, lz] of base) {
    flat[k] = lx
    flat[k + 1] = 0
    flat[k + 2] = lz
    k += 3
  }
  for (const [lx, lz] of base) {
    flat[k] = lx
    flat[k + 1] = h
    flat[k + 2] = lz
    k += 3
  }
  return { verts: flat, kind: 'convex' }
}

const BuildingColliders = ({ buildings }) => {
  const geoms = useMemo(
    () =>
      buildings.map((b) => {
        const g = hullVerts(b)
        return { key: b.x.toFixed(2) + ',' + b.z.toFixed(2), geom: g, x: b.x, z: b.z }
      }),
    [buildings],
  )
  return (
    <>
      {geoms.map(({ key, geom, x, z }) => {
        if (geom.kind === 'trimesh') {
          return (
            <RigidBody
              key={key}
              type="fixed"
              friction={1}
              collisionGroups={BUILDING_COLLISION_GROUPS}
              position={[x, 0, z]}
            >
              <TrimeshCollider args={[geom.verts, geom.indices]} />
            </RigidBody>
          )
        }
        return (
          <RigidBody
            key={key}
            type="fixed"
            friction={1}
            collisionGroups={BUILDING_COLLISION_GROUPS}
            position={[x, 0, z]}
          >
            <ConvexHullCollider args={[geom.verts]} />
          </RigidBody>
        )
      })}
    </>
  )
}

// Building window/night lights component
const BuildingLights = ({ buildings }) => {
  const gameTime = useGameStore((s) => s.gameTime ?? 12)

  // Compute darkness factor in [0, 1]
  // Dusk starts at 17:00, full night by 20:00, dawn starts at 05:00, full day by 08:00
  let darkness = 0
  if (gameTime >= 20 || gameTime < 5) {
    darkness = 1
  } else if (gameTime >= 17 && gameTime < 20) {
    darkness = (gameTime - 17) / 3
  } else if (gameTime >= 5 && gameTime < 8) {
    darkness = 1 - (gameTime - 5) / 3
  }

  const litBuildings = useMemo(() => {
    return buildings
      .map((b, i) => {
        const seed = hash(i * 13 + 42)
        // ~65% of buildings have lights on at night
        if (seed <= 0.35) return null

        const colors = ['#FFD566', '#FFAA33', '#FFC266', '#FFE082', '#FF9F43']
        const color = colors[Math.floor(hash(i * 7 + 9) * colors.length)]
        const lightY = Math.max(2, b.colH * 0.45)

        return {
          id: i,
          x: b.x,
          z: b.z,
          y: b.y0 + lightY,
          color,
          h: b.colH,
          w: b.w,
          d: b.d,
          seed,
        }
      })
      .filter(Boolean)
  }, [buildings])

  if (darkness <= 0.01) return null

  return (
    <group>
      {litBuildings.map((b) => (
        <group key={b.id} position={[b.x, b.y, b.z]}>
          <pointLight
            color={b.color}
            intensity={darkness * 2.2}
            distance={Math.max(16, Math.min(b.w, b.d) * 1.5)}
            decay={2}
          />
        </group>
      ))}
    </group>
  )
}

const City = () => {
  const [data, setData] = useState(null)
  const setSpawn = useGameStore((s) => s.setSpawn)

  useEffect(() => {
    fetch('/map_data.json')
      .then((res) => res.json())
      .then(setData)
      .catch((err) => console.error('Error loading map data:', err))
  }, [])

  const { meshMap, byModel } = useKenneyMeshes()

  const buildings = useMemo(
    () => (data ? planBuildings(data, byModel) : []),
    [data, byModel],
  )

  useEffect(() => {
    if (!data) return
    let best = null
    let bestDist = Infinity
    for (const road of data.roads) {
      for (const n of road.nodes) {
        const x = lonToWorldX(n.lon)
        const z = latToWorldZ(n.lat)
        const dist = x * x + z * z
        if (dist < bestDist) {
          bestDist = dist
          best = [x, z]
        }
      }
    }
    setSpawn(best ?? [0, 0])
  }, [data, setSpawn])

  return (
    <>
      {data && <Roads roads={data.roads} />}
      {buildings.length > 0 && (
        <>
          <Merged
            meshes={meshMap}
            limit={500}
            castShadow
            receiveShadow
            frustumCulled={false}
          >
            {(M) =>
              buildings.map((b, i) => (
                <group
                  key={i}
                  position={[b.x, b.y0, b.z]}
                  rotation={[0, b.rot, 0]}
                  scale={[b.sx, b.sy, b.sz]}
                >
                  {byModel[b.model].keys.map((key) => {
                    const Part = M[key]
                    return <Part key={key} />
                  })}
                </group>
              ))}
          </Merged>
          <BuildingColliders buildings={buildings} />
          <BuildingLights buildings={buildings} />
        </>
      )}
    </>
  )
}

export default City
