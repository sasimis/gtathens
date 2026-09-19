import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { latToWorldZ, lonToWorldX } from '../../lib/geo'
import { roadWidthFor } from '../Roads'
import { pointToSegmentDistSq, xzHull } from './cityGeometry'

const letters = 'abcdefghijklmnopqrstuvwx'.split('')

export const COMMERCIAL_MODELS = [
  ...letters.slice(0, 14).map((l) => `commercial/building-${l}`),
  ...letters.slice(0, 5).map((l) => `commercial/building-skyscraper-${l}`),
]
export const SKYSCRAPER_MODELS = COMMERCIAL_MODELS.slice(14)
export const SUBURBAN_MODELS = letters.slice(0, 21).map((l) => `suburban/building-type-${l}`)
export const INDUSTRIAL_MODELS = letters.slice(0, 20).map((l) => `industrial/building-${l}`)

export const MODEL_IDS = [...COMMERCIAL_MODELS, ...SUBURBAN_MODELS, ...INDUSTRIAL_MODELS]
export const MODEL_URLS = MODEL_IDS.map((id) => `/models/kenney/${id}.glb`)
MODEL_URLS.forEach((url) => useGLTF.preload(url))

export const POOLS = {
  commercial: COMMERCIAL_MODELS,
  suburban: SUBURBAN_MODELS,
  industrial: INDUSTRIAL_MODELS,
}

export const hash = (i) => {
  let h = (i * 2654435761) >>> 0
  h ^= h >>> 13
  h = (h * 1274126177) >>> 0
  return h / 4294967295
}

export const CATEGORY_DEFAULT_HEIGHT = {
  commercial: 15,
  civic: 12,
  mixed: 11,
  residential: 8.5,
  industrial: 7.5,
}

export const clamp = (v, min, max) => Math.min(Math.max(v, min), max)

export const DECORATION_RE = /^(bush|plant|tree|hedge|flower|planter|shrub|fence|bench|light|lamppost|sign)/i
export const TINY_CLUTTER_EW = 1.6
export const TINY_CLUTTER_EH = 1.2

export const pickPoolId = (category, area) => {
  if (category === 'industrial') return 'industrial'
  if (category === 'residential') return area < 350 ? 'suburban' : 'commercial'
  if (category === 'mixed' && area < 120) return 'suburban'
  return 'commercial'
}

export const posCandidate = (obj, originalName, modelSize, modelCenter) => {
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

let kenneyCache = null

export const buildKenneyCache = (scenes) => {
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

export const useKenneyMeshes = () => {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const scenes = MODEL_IDS.map((id) => useGLTF(`/models/kenney/${id}.glb`).scene)
  if (!kenneyCache) kenneyCache = buildKenneyCache(scenes)
  return kenneyCache
}

const ROAD_CLEAR_M = 2
const OUTLINE_ROAD_MARGIN = 2

export const planBuildings = (data, byModel) => {
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
