import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Merged, useGLTF } from '@react-three/drei'
import { ConvexHullCollider, RigidBody, TrimeshCollider } from '@react-three/rapier'
import * as THREE from 'three'
import Roads from './Roads'
import RoadFurniture from './RoadFurniture'
import { roadWidthFor } from './Roads'
import useGameStore from '../store/useGameStore'
import { latToWorldZ, lonToWorldX } from '../lib/geo'
import {
  buildRoadIndex,
  fitBoxToRoads,
  PAINTED_MIN_W,
  pushOutOfRoads,
  shrinkBoxClear,
} from '../lib/buildingFit'

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

/* -------------------------------------------------------------- */
/* Night window glow                                               */
/*                                                                  */
/* The Kenney GLBs have NO separate window material: every building */
/* is ONE mesh with ONE "colormap" atlas material — the blue window */
/* panels are palette swatches baked into that texture. So the glow */
/* runs INSIDE the shared material's shader (onBeforeCompile, patched */
/* once per material here):                                         */
/*   1. mask = dark + blue-tinted pixels of the sampled atlas color  */
/*      (walls are bright/white, base trim near-black → excluded);   */
/*   2. glow color = per-BUILDING pick from a palette, hashed from   */
/*      instanceMatrix[3].xz (each building is one instance of the   */
/*      city-wide <Merged> InstancedMesh) → yellow/blue/orange/etc;  */
/*   3. uNight = nightDarkness(gameTime), written per frame by       */
/*      BuildingLights' useFrame (same dusk ramp as the point lights).*/
/* The program is compiled once (same source for every material);    */
/* uniforms stay per-material via userData.gtNight.                  */
/* -------------------------------------------------------------- */
const glowMats = []

// Dusk factor in [0, 1]: 0 = full day, 1 = full night.
// Dusk starts 17:00, full night by 20:00; dawn starts 05:00, full day by 08:00.
// (Matches DayNightCycle's sky phases; shared by the point lights + glow.)
const nightDarkness = (t) => {
  if (t >= 20 || t < 5) return 1
  if (t >= 17 && t < 20) return (t - 17) / 3
  if (t >= 5 && t < 8) return 1 - (t - 5) / 3
  return 0
}

const patchWindowGlow = (mat) => {
  if (!mat || mat.userData.gtGlow) return
  mat.userData.gtGlow = true
  const nightU = { value: 0 }
  mat.userData.gtNight = nightU
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = nightU
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vGlowXZ;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  // World position of this building (the <Merged> InstancedMesh sits at
  // identity, so the instance matrix IS the building's world transform).
  vGlowXZ = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
#else
  vGlowXZ = vec2(0.0);
#endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uNight;
varying vec2 vGlowXZ;
// Robust hash (Dave Hoskins) — the sin() variant bands on big coords.
float gtHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// City-lights palette: warm yellow dominates, the rest adds variety.
vec3 gtGlowColor(float h) {
  if (h < 0.42) return vec3(1.00, 0.78, 0.42); // warm yellow
  if (h < 0.62) return vec3(0.40, 0.70, 1.00); // sky blue
  if (h < 0.74) return vec3(1.00, 0.55, 0.25); // orange
  if (h < 0.82) return vec3(1.00, 0.94, 0.78); // warm white
  if (h < 0.91) return vec3(0.45, 1.00, 0.86); // mint
  return vec3(1.00, 0.50, 0.82);               // pink
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
// Window mask on the RAW atlas color (this runs before lighting):
// dark (excludes white walls), not near-black (excludes the base trim),
// and blue-tinted — the window swatches in all three Kenney atlases are
// slate-navy; facade colors are warm/bright and fall outside this band.
float gtL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
float gtCool = diffuseColor.b - diffuseColor.r;
float gtW = smoothstep(0.05, 0.14, gtL)
          * (1.0 - smoothstep(0.30, 0.46, gtL))
          * smoothstep(0.012, 0.05, gtCool);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
float gtH = gtHash(vGlowXZ);
// ~22% of buildings keep their windows dark at night (still asleep).
float gtGate = step(0.22, gtHash(vGlowXZ + vec2(7.31, 1.77)));
totalEmissiveRadiance += gtGlowColor(gtH) * (0.75 + 0.5 * gtH) * gtW * uNight * gtGate * 1.6;`,
      )
  }
  glowMats.push(mat)
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
        // Night window glow: patch the SHARED colormap material once
        // (array materials preserved — industrial builds have 2 prims).
        if (Array.isArray(obj.material)) obj.material.forEach(patchWindowGlow)
        else patchWindowGlow(obj.material)
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

// Road fitting lives in lib/buildingFit.js (push rings off the carriageway +
// shrink the rendered box to a road-free rectangle); it is a pure module so
// scripts/building-fit.mjs can test the real code in Node.
const BUILDING_CLEAR_K = 0.3 // rendered box stays this far off the tarmac

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
      // Only paved carriageways push buildings; a footway/path is pavement and
      // often runs straight through a block.
      const paved = halfW * 2 >= PAINTED_MIN_W
      const nodes = road.nodes || []
      for (let k = 0; k < nodes.length - 1; k += 1) {
        const x1 = lonToWorldX(nodes[k].lon)
        const z1 = latToWorldZ(nodes[k].lat)
        const x2 = lonToWorldX(nodes[k + 1].lon)
        const z2 = latToWorldZ(nodes[k + 1].lat)
        if (Math.abs(x2 - x1) < 1e-6 && Math.abs(z2 - z1) < 1e-6) continue
        roadSegs.push({ x1, z1, x2, z2, halfW, paved })
      }
  }
  // The push-out only consults paved streets.
  const pavedSegs = roadSegs.filter((sg) => sg.paved)
  const roadIndex = buildRoadIndex(pavedSegs)
  // Reusable push scratch: [ring samples, candidate segments, centre].
  const pushScratch = [[], [], [0, 0]]
  // QA counters: how many OSM rings were dropped, and why (all ring-on-road
  // rejections live in pushOutOfRoads now).
  const rejected = { sliver: 0, onRoad: 0, pushed: 0, shrunk: 0, total: 0 }

  const planned = data.buildings.flatMap((b, i) => {
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
    // Every OSM building spawns: only degenerate slivers (< 2 m on a side)
    // or absurd rings (> 220 m) are discarded as bad data. Tiny sheds land
    // on the box fallback in the render path (no Kenney model fits 2 m).
    if (w < 2 || d < 2 || w > 220 || d > 220) { rejected.sliver += 1; return [] }

    let x = (minX + maxX) / 2
    let z = (minZ + maxZ) / 2

    // The Kenney model is fitted to the BBOX, so a chamfered / L-shaped footprint
    // would render as a box that swallows a street. Fit the box to the largest
    // road-free rectangle inside the footprint, then hard-verify it.
    let fit = fitBoxToRoads(minX, maxX, minZ, maxZ, roadIndex)
    if (!fit) { rejected.onRoad += 1; return [] }
    if (fit.w < w - 0.05 || fit.d < d - 0.05) rejected.shrunk += 1
    // Tiny sheds (< 3.5 m) take the plain-box fallback, which extrudes the OSM
    // RING - so the ring itself has to come off the carriageway. A 2 m shed
    // cannot oscillate the way a 40 m block can.
    if (Math.min(fit.w, fit.d) < 3.5) {
      const parked = pushOutOfRoads(outline, roadIndex, pushScratch)
      if (parked) {
        rejected.pushed += 1
        fit = { x: parked.x, z: parked.z, w: fit.w, d: fit.d }
      }
    }
    const clear = shrinkBoxClear(fit, roadIndex)
    if (!clear) { rejected.onRoad += 1; return [] }
    const bw = clear.w
    const bd = clear.d
    x = clear.x
    z = clear.z
    const area = bw * bd
    if (bw < 2 || bd < 2) { rejected.sliver += 1; return [] }

    let h
    if (b.height) h = b.height
    else if (b.levels) h = b.levels * 3.2
    else h = CATEGORY_DEFAULT_HEIGHT[b.category] * (0.7 + hash(i) * 0.6)
    h = clamp(h, 4, 120)

    const poolId = pickPoolId(b.category, area)
    // Tiny sheds/kiosks (< ~3.5 m on the short side): no Kenney model fits
    // without grotesque shrink, so flag the plain-box fallback (render path
    // draws a plaster box at true OSM size; hullVerts extrudes the outline).
    if (Math.min(bw, bd) < 3.5) {
      return [{
        x, z, y0: 0, rot: 0, sx: 1, sy: 1, sz: 1, w: bw, d: bd, h,
        colH: h, model: '__box__', footprint: null, outline,
      }]
    }
    let model
    if (poolId === 'commercial' && h >= 55) {
      model = SKYSCRAPER_MODELS[Math.floor(hash(i + 7) * SKYSCRAPER_MODELS.length)]
    } else {
      const pool = POOLS[poolId]
      model = pool[Math.floor(hash(i) * pool.length)]
    }
    const meta = byModel[model]

    const sx = (bw * 0.94) / meta.w
    const sz = (bd * 0.94) / meta.d
    const avgXZ = (sx + sz) / 2
    const sy = clamp(h / meta.h, avgXZ * 0.4, avgXZ * 4)

    const footprintLongX = bw >= bd
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
      w: bw,
      d: bd,
      h,
      colH: meta.h * sy,
      model,
      footprint,
      outline,
    }]
  })
  rejected.total = planned.length
  return { planned, rejected }
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
      buildings.map((b, i) => {
        const g = hullVerts(b)
        // Key on the INDEX, not on the position. Two OSM ways can round to the
        // same centimetre (this map has a pair at 239.00,18.89), and
        // x.toFixed(2)+','+z.toFixed(2) then produced TWO children with the
        // same key — React warned and, because key identity drives the
        // collider/mesh pairing, a duplicate means one building silently drops
        // out of the reconciler and its hull stops existing. The index is
        // stable for a given `buildings` array, which is all a key has to be.
        return { key: 'b' + i, geom: g, x: b.x, z: b.z }
      }),
    [buildings],
  )
  return (
    // ONE fixed body for the whole city, not one per building: with 417
    // buildings in play, 417 separate RigidBodies cost real frame time (the
    // fleet test dropped out at 46 fps). Colliders keep their own local offset,
    // so every hull lands in exactly the same world spot as before.
    <RigidBody type="fixed" colliders={false} friction={1}>
      {geoms.map(({ key, geom, x, z }) =>
        geom.kind === 'trimesh' ? (
          <TrimeshCollider
            key={key}
            args={[geom.verts, geom.indices]}
            position={[x, 0, z]}
            friction={1}
            collisionGroups={BUILDING_COLLISION_GROUPS}
          />
        ) : (
          <ConvexHullCollider
            key={key}
            args={[geom.verts]}
            position={[x, 0, z]}
            friction={1}
            collisionGroups={BUILDING_COLLISION_GROUPS}
          />
        ),
      )}
    </RigidBody>
  )
}

/** How many point lights the city may light at once. */
const BUILDING_LIGHT_POOL = 8
/** Beyond this, a lamp's spill is invisible (fog starts at 260 m). */
const BUILDING_LIGHT_RADIUS = 150

/**
 * A fixed-size pool of `<pointLight>`s re-aimed each frame at the lit
 * buildings nearest the camera.
 *
 * The pool members are STABLE React elements and only their
 * position/colour/intensity are mutated per frame, so re-targeting a lamp
 * never allocates, never remounts, and — critically — never changes the light
 * COUNT. three.js bakes `NUM_POINT_LIGHTS` into every lit material's compiled
 * program, so the whole point of the pool is that the constant stays small and
 * fixed; adding or removing a light would recompile every shader in the scene
 * mid-game (a multi-second freeze).
 */
const BuildingLightPool = React.memo(function BuildingLightPool({ lit, darkness }) {
  const refs = useRef([])
  // Reusable scratch for the nearest-N selection: no per-frame allocation.
  const scratch = useRef([])

  useFrame(({ camera }) => {
    const cx = camera.position.x
    const cz = camera.position.z
    const top = scratch.current
    for (let k = 0; k < BUILDING_LIGHT_POOL; k += 1) {
      let slot = top[k]
      if (!slot) { slot = { d: Infinity, b: null }; top[k] = slot }
      slot.d = Infinity
      slot.b = null
    }
    const r2 = BUILDING_LIGHT_RADIUS * BUILDING_LIGHT_RADIUS
    for (let i = 0; i < lit.length; i += 1) {
      const b = lit[i]
      const dx = b.x - cx
      const dz = b.z - cz
      const d = dx * dx + dz * dz
      if (d > r2) continue
      // Insertion into the fixed top-N (N is 8, so this is a couple of swaps).
      if (d >= top[BUILDING_LIGHT_POOL - 1].d) continue
      let k = BUILDING_LIGHT_POOL - 1
      while (k > 0 && top[k - 1].d > d) {
        top[k].d = top[k - 1].d
        top[k].b = top[k - 1].b
        k -= 1
      }
      top[k].d = d
      top[k].b = b
    }
    for (let k = 0; k < BUILDING_LIGHT_POOL; k += 1) {
      const l = refs.current[k]
      if (!l) continue
      const b = top[k].b
      if (!b) {
        // Nothing in range: zero the light instead of unmounting it, so the
        // light count (and therefore the compiled shader) never changes.
        l.intensity = 0
        continue
      }
      l.position.set(b.x, b.y, b.z)
      l.color.set(b.color)
      l.intensity = darkness * 2.2
      const reach = Math.max(16, Math.min(b.w, b.d) * 1.5)
      if (l.distance !== reach) l.distance = reach
    }
  })

  return (
    <>
      {Array.from({ length: BUILDING_LIGHT_POOL }, (_, i) => (
        <pointLight
          key={i}
          ref={(el) => { refs.current[i] = el }}
          color="#FFD566"
          intensity={0}
          distance={24}
          decay={2}
        />
      ))}
    </>
  )
})

// Building window/night lights component
const BuildingLights = ({ buildings }) => {
  const gameTime = useGameStore((s) => s.gameTime ?? 12)
  const darkness = nightDarkness(gameTime)

  // Window-glow uniforms: written per frame straight from the store (no
  // allocation, no React re-render) so the shader mask ramps smoothly with
  // dusk and reacts the same second as a HUD time jump. Must run BEFORE the
  // darkness early-return below (hooks are unconditional).
  useFrame(() => {
    const d = nightDarkness(useGameStore.getState().gameTime ?? 12)
    for (let i = 0; i < glowMats.length; i += 1) {
      const u = glowMats[i].userData.gtNight
      if (u) u.value = d
    }
  })

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

  // NOTE: the pool is mounted PERMANENTLY, at every hour. It used to
  // `if (darkness <= 0.01) return null` and unmount the 8 <pointLight>s at
  // sunrise, which made the light COUNT change 0 <-> 8 twice a day. three
  // bakes NUM_POINT_LIGHTS into every lit material, so the first crossing
  // recompiles the whole set and that cost is a FREEZE, not a dip: measured
  // with raw rAF deltas at 1280x720/high, the FIRST dusk stalled a single
  // frame for 1783 ms (1850 ms total; day MAX 33.4 ms). The SECOND dusk is
  // free at 33.4 ms because three caches the programs, so this is a
  // one-time-per-session 1.8 s lockup - and you cannot reproduce it by
  // flipping the clock twice, which is exactly why the HUD clock button
  // test always looked clean.
  //
  // The trade, measured the same way: daytime frame time 19.86 -> 21.69 ms
  // (programs 29 -> 33) for the 8 lights that are always in the shader, and
  // every crossing now reads MAX 33.5 ms / 0 ms stall. So it is ~1.8 ms per
  // frame (about 9%) in daylight to delete a 1.8-second lockup - worth it,
  // but NOT free, so do not add more lights to the pool on a hunch.
  // Daylight here is simply darkness = 0, so the pool sets intensity to 0
  // and contributes no visible light (verified by screenshot).

  /**
   * NIGHT-LIGHT BUDGET — the other half of the framerate fix.
   *
   * This used to mount one `<pointLight>` for EVERY lit building: ~270 of
   * them in this map. That is the classic three.js cliff — the renderer
   * uploads all point lights into every lit material's uniform block, so the
   * FRAGMENT shader loops over all 270 per pixel, for every surface in the
   * scene, every frame. It gets dramatically worse exactly where the player
   * is looking at buildings, which is why the framerate collapsed in the city
   * centre and recovered in the open.
   *
   * The fix keeps the look and drops the cost: a small POOL of real point
   * lights is re-aimed each frame at the lit buildings nearest the camera. A
   * street lamp 300 m away contributes nothing you can see (fog and the
   * distance cutoff both hide it), so the pool is indistinguishable from the
   * full set while the shader cost becomes CONSTANT.
   *
   * The baked window-glow shader (patchWindowGlow) is untouched and still
   * lights every building — this pool is only the warm spill onto the street.
   */
  return <BuildingLightPool lit={litBuildings} darkness={darkness} />
}

// BuildingLights is declared BELOW BuildingLightPool on purpose. It used to be
// declared ABOVE it with the pool + its two constants nested inside its own
// body, i.e. textually AFTER its own `return`. That is a temporal dead zone:
// the `return <BuildingLightPool/>` reads the binding before the `const` below
// it has been evaluated. It only survived the day because the
// `if (darkness <= 0.01) return null` guard returned first — so the first frame
// where the city actually got dark threw
//   ReferenceError: Cannot access 'BuildingLightPool' before initialization
// inside <Canvas>, the error boundary unmounted the whole scene, and the
// "night sky" was a blank frame with no sky in it at all. Declare before use.
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

  // planBuildings returns { planned, rejected } - `rejected` explains any gap
  // between the OSM count and the spawned count (sliver rings, rings buried in
  // a road) so the "all OSM buildings spawn" invariant stays checkable.
  const plan = useMemo(
    () => (data ? planBuildings(data, byModel) : { planned: [], rejected: { sliver: 0, onRoad: 0, pushed: 0, total: 0 } }),
    [data, byModel],
  )
  const buildings = plan.planned
  // QA seam for the "all OSM buildings spawn" invariant: planBuildings input
  // vs output counts, no per-frame cost (recomputed only on data load).
  useEffect(() => {
    if (typeof window === 'undefined' || !data) return
    window.__gtathensBuildings = {
      osm: (data.buildings || []).length,
      planned: buildings.length,
      ...plan.rejected,
    }
  }, [data, buildings, plan])

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
      {data && <RoadFurniture roads={data.roads} />}
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
              buildings.map((b, i) => {
                // Tiny-footprint fallback: no Kenney model fits a ~2 m shed
                // without grotesque shrink — render a plain plaster box with a
                // flat roof at the true OSM size so the building still EXISTS
                // (and the collider below still traces it).
                if (b.model === '__box__') {
                  return (
                    <group key={i} position={[b.x, 0, b.z]}>
                      <mesh position={[0, b.colH / 2, 0]} castShadow receiveShadow>
                        <boxGeometry args={[b.w * 0.94, b.colH, b.d * 0.94]} />
                        <meshStandardMaterial color="#cfc8bb" roughness={0.9} metalness={0} />
                      </mesh>
                    </group>
                  )
                }
                return (
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
                )
              })}
          </Merged>
          <BuildingColliders buildings={buildings} />
          <BuildingLights buildings={buildings} />
        </>
      )}
    </>
  )
}

export default City
