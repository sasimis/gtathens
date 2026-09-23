// @ts-nocheck
import React, { useRef, useMemo, useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { loadWorldData, grassPolygons } from '../lib/worldData'
import useGameStore from '../store/useGameStore'

/**
 * GrassArea v2 — lawn base + instanced blades.
 *
 * Why two layers: a vertical blade is nearly invisible from a top-down /
 * far camera (its cross-section is ~10 cm), so far-field green MUST come
 * from flat lawn patches (ShapeGeometry at y≈0.025). Blades (taller,
 * varied, wind-blown) carry the near field < ~30 m. Either layer alone
 * looks broken: lawn-only = "golf green", blades-only = "invisible".
 *
 * Budgets by graphics quality (no per-frame allocations anywhere —
 * useFrame only advances the shared _time uniform):
 *   low 15k / medium 30k / high 50k thin blades, stride-sampled from a
 *   dense deterministic grid so every poly gets a fair, area-proportional
 *   share (the old code capped the FIRST poly at MAX_BLADES and starved
 *   the rest). Blades stay thin (~3.5 cm) — density + yaw/height/color
 *   variation carries the realism, not fat geometry.
 */

const GRASS_SEGMENTS = 2 // 2 quads + tip = 5 tris/blade (was 3 → 7 tris)
const GRASS_HEIGHT = 0.32 // ~ankle height w/ scale range 0.7–1.2 m
const GRASS_BASE_WIDTH = 0.035
const GRASS_HALF_WIDTH = 0.012
const BLADE_CURVE = 0.06 // forward bend at the tip (no more straight planes)
const BLADES_BY_QUALITY = { low: 15000, medium: 30000, high: 50000 }
const LAWN_Y = 0.025

// Deterministic per-index pseudo-random in [0,1) — stable across renders
// (Math.random would reshuffle every mount + break the smoke determinism).
const rand01 = (i, salt) => {
  let h = ((i * 2654435761 + salt * 40503) >>> 0)
  h ^= h >>> 13
  h = (h * 1274126177) >>> 0
  h ^= h >>> 16
  return h / 4294967295
}

function makeBladeGeo() {
  const verts = []
  const uvs = []
  for (let i = 0; i < GRASS_SEGMENTS; i++) {
    const t0 = i / GRASS_SEGMENTS
    const t1 = (i + 1) / GRASS_SEGMENTS
    const w0 = GRASS_BASE_WIDTH + (GRASS_HALF_WIDTH - GRASS_BASE_WIDTH) * t0
    const w1 = GRASS_BASE_WIDTH + (GRASS_HALF_WIDTH - GRASS_BASE_WIDTH) * t1
    const y0 = t0 * GRASS_HEIGHT
    const y1 = t1 * GRASS_HEIGHT
    // Bent spine: x offset grows quadratically so the tip leans over.
    const b0 = BLADE_CURVE * t0 * t0
    const b1 = BLADE_CURVE * t1 * t1
    verts.push(b0, y0, -w0, b0, y0, w0, b1, y1, -w1, b1, y1, w1)
    // u = 0 left edge / 1 right edge, v = elevation (drives taper + color ramp)
    uvs.push(0, t0, 1, t0, 0, t1, 1, t1)
  }
  const bt = BLADE_CURVE
  verts.push(bt, GRASS_HEIGHT, 0, bt, GRASS_HEIGHT, -GRASS_HALF_WIDTH, bt, GRASS_HEIGHT, GRASS_HALF_WIDTH)
  uvs.push(0.5, 1, 0, 1, 1, 1)
  const positions = new Float32Array(verts)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2))
  const idx = []
  for (let i = 0; i < GRASS_SEGMENTS; i++) {
    const b = i * 4
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2)
  }
  const tipBase = GRASS_SEGMENTS * 4
  idx.push(tipBase, tipBase + 1, tipBase + 2)
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

const BLADE_GEO = makeBladeGeo()

const vertexShader = /* glsl */`
  attribute vec3 instancePosition;
  attribute vec4 instanceRandom;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uBend;

  varying float vElevation;
  varying float vSide;
  varying float vColorVar;
  varying float vPatch;
  varying vec3 vNormal;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    float yN = clamp(position.y / 0.32, 0.0, 1.0);
    vec3 localPos = position;
    // Per-blade variation: height 0.6x–1.4x, width 0.7x–1.3x so the field
    // is not a row of clones. instanceRandom = (height, color, phase, lean).
    float hScale = 0.6 + instanceRandom.x * 0.8;
    float wScale = 0.7 + fract(instanceRandom.y * 7.31) * 0.6;
    localPos.y *= hScale;
    localPos.z *= wScale;
    localPos.x *= (0.8 + hScale * 0.2);
    float n = noise(instancePosition.xz * 0.35 + vec2(uTime * uSpeed * 0.35, instanceRandom.z));
    float wind = n * 2.0 - 1.0;
    float bend = uBend * (0.35 + 0.65 * instanceRandom.w) * wind * yN * yN;
    localPos.x += bend;

    float swayN = noise(instancePosition.xz * 0.9 + vec2(100.0 + uTime * uSpeed * 0.15, instanceRandom.z));
    float sway = swayN * 2.0 - 1.0;
    localPos.z += sway * 0.05 * yN;

    // Random yaw per blade + camera billboard: blades no longer all face
    // one way (that uniform comb-over is what read as "fat"/fake). Yaw is
    // hashed from the per-instance phase so it is stable across frames.
    float yaw = fract(instanceRandom.z * 0.1591549) * 6.2831853;
    // cameraPosition is a built-in uniform (world space). The group sits at
    // the origin so instancePosition == world XZ. NOTE: inverse(viewMatrix)
    // was used here before — it is NOT available in GLSL ES 1.00 and failed
    // to compile, which made every blade vanish silently.
    vec2 toCam = cameraPosition.xz - instancePosition.xz;
    // Guard: exactly under/over the blade → toCam is ~0, atan(0,0) is UB.
    float camAngle = atan(toCam.y, toCam.x + 1e-4);
    float angle = camAngle * 0.55 + yaw * 0.45;
    float c = cos(angle);
    float s = sin(angle);
    mat3 rot = mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c);
    localPos = rot * localPos;

    vec4 worldPos = modelMatrix * vec4(instancePosition, 1.0) + vec4(localPos, 0.0);
    vElevation = yN;
    vSide = clamp(position.z / 0.035, -1.0, 1.0);
    vColorVar = instanceRandom.y;
    // Static large-scale mottling so the lawn is patchy, not golf-green.
    vPatch = noise(instancePosition.xz * 0.12) * 0.65 + noise(instancePosition.xz * 0.45 + 7.3) * 0.35;
    vNormal = normalize(vec3(s, 0.35, c));

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const fragmentShader = /* glsl */`
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform vec3 uDryColor;
  uniform vec3 uLightDir;
  uniform vec3 uLightColor;
  uniform float uAmbient;

  varying float vElevation;
  varying float vSide;
  varying float vColorVar;
  varying float vPatch;
  varying vec3 vNormal;

  void main() {
    float grad = smoothstep(0.0, 1.0, vElevation);
    // Patchy meadow: large-scale dry/worn mottling + per-blade hue jitter.
    vec3 base = mix(uBaseColor * (0.7 + vColorVar * 0.55), uDryColor, smoothstep(0.55, 0.95, vPatch) * 0.65);
    base = mix(base, uDryColor, step(0.93, vColorVar) * 0.7);
    vec3 color = mix(base, uTipColor * (0.8 + vColorVar * 0.4), grad);
    // Sun-bleached tips on dry patches, lusher tips elsewhere.
    color = mix(color, uDryColor * 1.15, smoothstep(0.6, 1.0, vPatch) * grad * 0.45);
    float ao = 0.55 + 0.45 * smoothstep(0.0, 0.45, vElevation);
    float edge = 1.0 - abs(vSide);
    color *= (0.8 + 0.2 * edge) * ao;
    vec3 n = normalize(vNormal);
    vec3 L = normalize(uLightDir);
    float diff = max(0.0, dot(n, L));
    float backlit = pow(clamp(1.0 - dot(n, L) * 0.5 - 0.5, 0.0, 1.0), 2.0);
    vec3 lighting = uLightColor * (uAmbient + (1.0 - uAmbient) * diff) + uTipColor * backlit * 0.35;
    color *= lighting;
    gl_FragColor = vec4(color, 1.0);
  }
`

function polyBox(poly) {
  if (poly.length < 3) return null
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const [x, z] of poly) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const pad = 0.15
  minX += pad; maxX -= pad; minZ += pad; maxZ -= pad
  if (maxX <= minX || maxZ <= minZ) return null
  return { minX, maxX, minZ, maxZ }
}

function pointInPoly(x, z, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1]
    const xj = poly[j][0], zj = poly[j][1]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)
      inside = !inside
  }
  return inside
}

// Shoelace area — splits the blade budget proportionally so a huge park
// doesn't starve the small verges (v1 bug: first poly ate the whole cap).

function buildInstances(grassPolys, budget) {
  const boxes = []
  for (const poly of grassPolys) {
    const box = polyBox(poly)
    if (!box) continue
    boxes.push({ poly, box })
  }
  if (boxes.length === 0) return { count: 0 }
  const GRID = 0.22
  const perPoly = []
  let denseTotal = 0
  for (const b of boxes) {
    const nx = Math.max(2, Math.ceil((b.box.maxX - b.box.minX) / GRID))
    const nz = Math.max(2, Math.ceil((b.box.maxZ - b.box.minZ) / GRID))
    const pts = []
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const gx = ix + (iz % 2) * 0.5
        const x = b.box.minX + ((gx + 0.5) / nx) * (b.box.maxX - b.box.minX)
        const z = b.box.minZ + ((iz + 0.5) / nz) * (b.box.maxZ - b.box.minZ)
        if (pointInPoly(x, z, b.poly)) pts.push([x, z])
      }
    }
    perPoly.push(pts)
    denseTotal += pts.length
  }
  if (denseTotal === 0) return { count: 0 }
  const keepFrac = Math.min(1, budget / denseTotal)
  const xs = []
  const zs = []
  const ss = []
  const cv = []
  const ph = []
  const ln = []
  let seed = 0
  for (let p = 0; p < boxes.length; p++) {
    const pts = perPoly[p]
    const target = Math.max(24, Math.round(pts.length * keepFrac))
    const stride = Math.max(1, Math.floor(pts.length / Math.max(1, target)))
    for (let k = 0; k < pts.length; k += stride) {
      const pair = pts[k]
      const j = seed++
      xs.push(pair[0] + (rand01(j, 11) - 0.5) * 0.16)
      zs.push(pair[1] + (rand01(j, 12) - 0.5) * 0.16)
      // 0..1 raw channels — the shader maps height 0.6–1.4x so blades
      // vary without ever going leafless-short or corn-tall.
      ss.push(rand01(j, 13))
      cv.push(rand01(j, 14))
      ph.push(rand01(j, 15) * 20.0)
      ln.push(0.5 + rand01(j, 16) * 1.0)
      if (xs.length >= budget) break
    }
    if (xs.length >= budget) break
  }
  const count = xs.length
  const positions = new Float32Array(count * 3)
  const randoms = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    positions[i * 3] = xs[i]
    positions[i * 3 + 1] = 0
    positions[i * 3 + 2] = zs[i]
    randoms[i * 4] = ss[i]
    randoms[i * 4 + 1] = cv[i]
    randoms[i * 4 + 2] = ph[i]
    randoms[i * 4 + 3] = ln[i]
  }
  return { positions, randoms, count }
}

function buildLawnGeometry(grassPolys) {
  const geos = []
  for (const poly of grassPolys) {
    if (poly.length < 3) continue
    const shape = new THREE.Shape()
    shape.moveTo(poly[0][0], -poly[0][1])
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i][0], -poly[i][1])
    shape.closePath()
    try {
      const g = new THREE.ShapeGeometry(shape)
      g.rotateX(-Math.PI / 2)
      geos.push(g)
    } catch { /* degenerate ring — skip */ }
  }
  if (geos.length === 0) return null
  let vTotal = 0
  let iTotal = 0
  for (const g of geos) {
    vTotal += g.attributes.position.count
    iTotal += g.index ? g.index.count : g.attributes.position.count
  }
  const pos = new Float32Array(vTotal * 3)
  const norm = new Float32Array(vTotal * 3)
  const col = new Float32Array(vTotal * 3)
  // Meadow mottle palette (linear-ish 0..1): lush base, dry patch, worn edge.
  const C_LUSH = [0.16, 0.34, 0.08]
  const C_MID = [0.25, 0.42, 0.12]
  const C_DRY = [0.48, 0.46, 0.16]
  const lawnRand = (x, z, s) => {
    const h = Math.sin(x * 127.1 + z * 311.7 + s * 74.7) * 43758.5453
    return h - Math.floor(h)
  }
  const IndexArray = vTotal > 65535 ? Uint32Array : Uint16Array
  const idx = new IndexArray(iTotal)
  let vOff = 0
  let iOff = 0
  for (const g of geos) {
    const p = g.attributes.position.array
    pos.set(p, vOff * 3)
    for (let i = 0; i < g.attributes.position.count; i++) {
      norm[(vOff + i) * 3] = 0
      norm[(vOff + i) * 3 + 1] = 1
      norm[(vOff + i) * 3 + 2] = 0
      // Per-vertex meadow mottle: two sine-octave patch fields + jitter so
      // the lawn reads as worn grass, not a flat golf green.
      const vx = p[i * 3]
      const vz = p[i * 3 + 2]
      const patch = 0.6 * (0.5 + 0.5 * Math.sin(vx * 0.35 + vz * 0.21)) + 0.4 * (0.5 + 0.5 * Math.sin(vx * 0.09 - vz * 0.13 + 2.1))
      const j = (lawnRand(vx, vz, 3) - 0.5) * 0.09
      let r, gg, b
      if (patch < 0.5) {
        const t = patch / 0.5
        r = C_LUSH[0] + (C_MID[0] - C_LUSH[0]) * t
        gg = C_LUSH[1] + (C_MID[1] - C_LUSH[1]) * t
        b = C_LUSH[2] + (C_MID[2] - C_LUSH[2]) * t
      } else {
        const t = (patch - 0.5) / 0.5
        r = C_MID[0] + (C_DRY[0] - C_MID[0]) * t
        gg = C_MID[1] + (C_DRY[1] - C_MID[1]) * t
        b = C_MID[2] + (C_DRY[2] - C_MID[2]) * t
      }
      col[(vOff + i) * 3] = Math.min(1, Math.max(0, r + j))
      col[(vOff + i) * 3 + 1] = Math.min(1, Math.max(0, gg + j))
      col[(vOff + i) * 3 + 2] = Math.min(1, Math.max(0, b + j * 0.5))
    }
    if (g.index) {
      const ia = g.index.array
      for (let i = 0; i < ia.length; i++) idx[iOff + i] = ia[i] + vOff
      iOff += ia.length
    } else {
      for (let i = 0; i < g.attributes.position.count; i++) idx[iOff + i] = vOff + i
      iOff += g.attributes.position.count
    }
    vOff += g.attributes.position.count
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3))
  out.setAttribute('color', new THREE.BufferAttribute(col, 3))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  // Shape was authored as (x, -z); rotateX(-90°) maps (x,-z,0) → (x,0,z).
  out.translate(0, LAWN_Y, 0)
  return out
}

const _time = { value: 0 }
const LAWN_MATERIAL = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })

const GrassArea = () => {
  const [grassPolys, setGrassPolys] = useState(null)
  const quality = useGameStore((s) => s.settings.quality)
  const budget = BLADES_BY_QUALITY[quality] ?? BLADES_BY_QUALITY.high

  useEffect(() => {
    let alive = true
    loadWorldData()
     .then((data) => {
        if (!alive) return
        const polys = grassPolygons(data)
        if (polys.length > 0) setGrassPolys(polys)
      })
     .catch(() => {})
    return () => { alive = false }
  }, [])

  const instances = useMemo(() => {
    if (!grassPolys) return null
    return buildInstances(grassPolys, budget)
  }, [grassPolys, budget])

  const lawnGeo = useMemo(() => {
    if (!grassPolys) return null
    return buildLawnGeometry(grassPolys)
  }, [grassPolys])

  const bladesGeo = useMemo(() => {
    if (!instances || instances.count === 0) return null
    // InstancedBufferGeometry + a plain <mesh> sidesteps the R3F
    // <instancedMesh> + <instancedBufferAttribute attach=...> path entirely
    // (that attach crashed: instancedMesh has no .attributes, hence
    // "Cannot read properties of undefined (reading 'instancePosition')"
    // which took down the whole Canvas via the error boundary).
    const g = new THREE.InstancedBufferGeometry()
    if (BLADE_GEO.index) g.setIndex(BLADE_GEO.index.clone())
    for (const name of ['position', 'normal', 'uv']) {
      const attr = BLADE_GEO.getAttribute(name)
      if (attr) g.setAttribute(name, attr.clone())
    }
    g.setAttribute('instancePosition', new THREE.InstancedBufferAttribute(instances.positions, 3))
    g.setAttribute('instanceRandom', new THREE.InstancedBufferAttribute(instances.randoms, 4))
    g.instanceCount = instances.count
    return g
  }, [instances])

  useEffect(() => () => {
    if (lawnGeo) lawnGeo.dispose()
    if (bladesGeo) bladesGeo.dispose()
  }, [lawnGeo, bladesGeo])

  const uniforms = useMemo(() => ({
    uTime: _time,
    uSpeed: { value: 0.6 },
    uBend: { value: 0.22 },
    uBaseColor: { value: new THREE.Color('#2d5a1e') },
    uTipColor: { value: new THREE.Color('#62a83a') },
    uDryColor: { value: new THREE.Color('#8a8c2f') },
    uLightDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uLightColor: { value: new THREE.Color('#ffffff') },
    uAmbient: { value: 0.45 },
  }), [])

  useFrame(() => { _time.value += 0.016 })

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.__gtathensGrass = {
      polys: grassPolys ? grassPolys.length : 0,
      blades: instances ? instances.count : 0,
      lawnTris: lawnGeo && lawnGeo.index ? Math.round(lawnGeo.index.count / 3) : 0,
    }
    // eslint-disable-next-line no-console
    console.log(`[GrassArea] polys=${grassPolys ? grassPolys.length : 0} blades=${instances ? instances.count : 0}`)
  }, [grassPolys, instances, lawnGeo])

  if (!grassPolys) return null

  return (
    <group>
      {lawnGeo && (
        <mesh geometry={lawnGeo} material={LAWN_MATERIAL} receiveShadow />
      )}
      {bladesGeo && (
        <mesh
          geometry={bladesGeo}
          frustumCulled={false}
        >
          <shaderMaterial
            uniforms={uniforms}
            vertexShader={vertexShader}
            fragmentShader={fragmentShader}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </group>
  )
}

export default GrassArea