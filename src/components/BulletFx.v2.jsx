// Pooled bullet FX: tracers, muzzle flash (+ light), surface-aware impact
// bursts and bullet-hole decals.
// A fixed pool of meshes is allocated once and mutated in place every shot —
// module functions (fireTracer / muzzleFlash / impactFlash) never allocate and
// never re-render; the <BulletFx/> component just fades/ages the pool in
// useFrame. Pools are module scope so a remount never leaks or double-allocates.
import React from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

// Impact materials reported by WeaponController (see surfaceKind there).
export const IMPACT_CONCRETE = 1 // grey chip + dust
export const IMPACT_DUST = 2 // ground puff
export const IMPACT_METAL = 3 // bright sparks (cars)
export const IMPACT_FLESH = 4 // red burst (peds)

const TRACER_POOL = 12
const TRACER_LIFE = 0.07
const FLASH_LIFE = 0.055
const IMPACT_LIFE = 0.14
const DECAL_POOL = 22
const DECAL_HOLD = 9 // seconds a bullet hole stays before it fades out
const DECAL_FADE = 1.6

const mid = new THREE.Vector3()
const look = new THREE.Vector3()

// --- tracers ----------------------------------------------------------------
const slots = []
for (let i = 0; i < TRACER_POOL; i += 1) {
  slots.push({ ttl: 0, life: TRACER_LIFE, mesh: null })
}
let cursor = 0

/** Stretches a pooled tracer beam from (x0,y0,z0) to (x1,y1,z1). */
export const fireTracer = (x0, y0, z0, x1, y1, z1) => {
  const slot = slots[cursor]
  cursor = (cursor + 1) % TRACER_POOL
  const mesh = slot.mesh
  if (!mesh) return
  const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0)
  if (len < 0.05) return
  mid.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  mesh.position.copy(mid)
  look.set(x1, y1, z1)
  mesh.lookAt(look)
  // Thin and glowing: 3 cm wide, scaled along its own Z to the shot length.
  mesh.scale.set(1, 1, len)
  slot.ttl = TRACER_LIFE
  slot.life = TRACER_LIFE
  mesh.visible = true
}

// --- muzzle flash (one instance, retriggered) -------------------------------
let flashTTL = 0
const flashMesh = { current: null }
const flashLight = { current: null }

/** Shared muzzle flash at the barrel tip — quad + a short-lived point light. */
export const muzzleFlash = (x, y, z) => {
  const m = flashMesh.current
  if (m) {
    m.position.set(x, y, z)
    // Random roll so consecutive shots do not strobe identically.
    m.rotation.z = Math.random() * Math.PI
    flashTTL = FLASH_LIFE
    m.visible = true
  }
  if (flashLight.current) {
    flashLight.current.position.set(x, y, z)
    flashLight.current.intensity = 6
  }
}

// --- impacts ----------------------------------------------------------------
// A per-kind burst: colour, size and whether it grows (dust puffs) or snaps
// (sparks / flesh). One pool, retriggered round-robin.
const IMPACT_STYLE = {
  [IMPACT_CONCRETE]: { color: '#d8d2c4', size: 0.085, grow: 1.4 },
  [IMPACT_DUST]: { color: '#b9a887', size: 0.11, grow: 2.2 },
  [IMPACT_METAL]: { color: '#ffe9a0', size: 0.06, grow: 0.9 },
  [IMPACT_FLESH]: { color: '#ff4d4d', size: 0.075, grow: 1.1 },
}
const IMPACT_MAX = 6
const impacts = []
for (let i = 0; i < IMPACT_MAX; i += 1) {
  impacts.push({ ttl: 0, life: IMPACT_LIFE, grow: 1, mesh: null })
}
let impactCursor = 0

/**
 * Small burst where a bullet lands. `kind` picks the material look, and the
 * optional surface normal orients the puff away from the wall.
 */
export const impactFlash = (x, y, z, kind = IMPACT_CONCRETE, nx = 0, ny = 1, nz = 0) => {
  const style = IMPACT_STYLE[kind] || IMPACT_STYLE[IMPACT_CONCRETE]
  const slot = impacts[impactCursor]
  impactCursor = (impactCursor + 1) % IMPACT_MAX
  const m = slot.mesh
  if (!m) return
  m.position.set(x, y, z)
  if (nx !== 0 || ny !== 0 || nz !== 0) {
    look.set(x + nx, y + ny, z + nz)
    m.lookAt(look)
  }
  m.material.color.set(style.color)
  m.material.opacity = 1
  m.scale.setScalar(style.size)
  slot.size = style.size
  slot.grow = style.grow
  slot.ttl = IMPACT_LIFE
  slot.life = IMPACT_LIFE
  m.visible = true
}

// --- bullet holes -----------------------------------------------------------
// A soft radial-gradient texture generated once (no image asset) so every decal
// can share ONE material — a ring buffer of small quads that a shot stamps onto
// the surface, lined up with the hit normal.
let decalTexture = null
const makeDecalTexture = () => {
  if (decalTexture || typeof document === 'undefined') return decalTexture
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const g = c.getContext('2d')
  if (!g) return null
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 30)
  grad.addColorStop(0, 'rgba(12,10,9,0.95)')
  grad.addColorStop(0.55, 'rgba(24,20,18,0.7)')
  grad.addColorStop(1, 'rgba(30,26,22,0)')
  g.fillStyle = grad
  g.beginPath()
  g.arc(32, 32, 30, 0, Math.PI * 2)
  g.fill()
  const tex = new THREE.CanvasTexture(c)
  tex.needsUpdate = true
  decalTexture = tex
  return tex
}

const decals = []
for (let i = 0; i < DECAL_POOL; i += 1) {
  decals.push({ ttl: 0, mesh: null })
}
let decalCursor = 0
const decalNormal = new THREE.Vector3()

/**
 * Stamps a bullet hole on a surface. Skipped for flesh (no holes in people) and
 * when the hit came with no usable normal.
 */
export const impactDecal = (x, y, z, nx, ny, nz) => {
  if (nx === 0 && ny === 0 && nz === 0) return
  const slot = decals[decalCursor]
  decalCursor = (decalCursor + 1) % DECAL_POOL
  const m = slot.mesh
  if (!m) return
  decalNormal.set(nx, ny, nz).normalize()
  m.position.set(x + decalNormal.x * 0.012, y + decalNormal.y * 0.012, z + decalNormal.z * 0.012)
  // The quad's +Z is the decal's facing; point it along the surface normal.
  look.set(x + decalNormal.x * 1.2, y + decalNormal.y * 1.2, z + decalNormal.z * 1.2)
  m.lookAt(look)
  m.material.opacity = 0.9
  slot.ttl = DECAL_HOLD + DECAL_FADE
  m.visible = true
}
export const BulletFx = () => {
  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05)
    let anyTTL = false

    // Tracers (thin stretched boxes) fade out over TRACER_LIFE.
    for (let i = 0; i < TRACER_POOL; i += 1) {
      const s = slots[i]
      const mesh = s.mesh
      if (!mesh || s.ttl <= 0) continue
      s.ttl -= dt
      const k = Math.max(0, s.ttl / s.life)
      mesh.material.opacity = k
      if (s.ttl <= 0) mesh.visible = false
      anyTTL = true
    }

    // Muzzle flash: bright for ~0.05 s with a matching light spike.
    if (flashTTL > 0) {
      flashTTL -= dt
      const k = Math.max(0, flashTTL / FLASH_LIFE)
      const m = flashMesh.current
      if (m) {
        m.material.opacity = k
        m.scale.setScalar(0.75 + k * 0.5)
        if (flashTTL <= 0) m.visible = false
      }
      if (flashLight.current) {
        flashLight.current.intensity = k * 6
        if (flashTTL <= 0) flashLight.current.intensity = 0
      }
      anyTTL = true
    }

    // Impacts: sparks snap away, dust puffs swell outward.
    for (let i = 0; i < IMPACT_MAX; i += 1) {
      const s = impacts[i]
      const m = s.mesh
      if (!m || s.ttl <= 0) continue
      s.ttl -= dt
      const k = Math.max(0, s.ttl / s.life)
      m.material.opacity = k
      m.scale.setScalar(s.size * (1 + (1 - k) * s.grow))
      if (s.ttl <= 0) m.visible = false
      anyTTL = true
    }

    // Decals: hold, then fade out only at the very end of their life.
    for (let i = 0; i < DECAL_POOL; i += 1) {
      const s = decals[i]
      const m = s.mesh
      if (!m || s.ttl <= 0) continue
      s.ttl -= dt
      if (s.ttl < DECAL_FADE) {
        m.material.opacity = Math.max(0, (s.ttl / DECAL_FADE) * 0.9)
      }
      if (s.ttl <= 0) m.visible = false
      anyTTL = true
    }
    return anyTTL
  })

  // One shared decal material (canvas gradient) — built on first render so a
  // headless/probe environment without `document` still mounts.
  const decalMat = React.useMemo(() => {
    const tex = makeDecalTexture()
    if (!tex) return null
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  }, [])

  return (
    <>
      {slots.map((s, i) => (
        <mesh
          key={`t${i}`}
          ref={(m) => { s.mesh = m }}
          visible={false}
          frustumCulled={false}
        >
          <boxGeometry args={[0.03, 0.03, 1]} />
          <meshBasicMaterial color="#ffd75e" transparent opacity={1} depthWrite={false} />
        </mesh>
      ))}
      {/* Impact bursts: a flat quad that always faces the impact normal. */}
      {impacts.map((s, i) => (
        <mesh
          key={`i${i}`}
          ref={(m) => { s.mesh = m }}
          visible={false}
          frustumCulled={false}
        >
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial color="#d8d2c4" transparent opacity={1} depthWrite={false} />
        </mesh>
      ))}
      {/* Bullet holes (shared material + generated gradient texture). */}
      {decalMat && decals.map((s, i) => (
        <mesh
          key={`d${i}`}
          ref={(m) => { s.mesh = m }}
          visible={false}
          frustumCulled={false}
        >
          <planeGeometry args={[0.26, 0.26]} />
          <primitive object={decalMat} attach="material" />
        </mesh>
      ))}
      {/* Muzzle flash: bright quad + a short-lived point light. */}
      <mesh
        ref={(m) => { flashMesh.current = m }}
        visible={false}
        frustumCulled={false}
      >
        <planeGeometry args={[0.3, 0.3]} />
        <meshBasicMaterial
          color="#ffe9a0"
          transparent
          opacity={1}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <pointLight
        ref={(l) => { flashLight.current = l }}
        color="#ffcf6e"
        intensity={0}
        distance={9}
        decay={2}
      />
    </>
  )
}

export default BulletFx