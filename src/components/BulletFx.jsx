// Pooled bullet FX: tracers, muzzle flash, impact sparks.
// A fixed pool of meshes is allocated once and mutated in place every shot —
// module functions (fireTracer / muzzleFlash / impactFlash) never allocate and
// never re-render; the <BulletFx/> component just fades the pool in useFrame.
import React, { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const TRACER_POOL = 10
const TRACER_LIFE = 0.075
const FLASH_LIFE = 0.05

// Module state: pool slots + round-robin cursor (survives remounts).
const slots = []
for (let i = 0; i < TRACER_POOL; i += 1) {
  slots.push({ ttl: 0, life: TRACER_LIFE })
}
let cursor = 0
let flashTTL = 0
let impactTTL = 0

const mid = new THREE.Vector3()
const look = new THREE.Vector3()

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
  mesh.scale.set(1, 1, len)
  slot.ttl = TRACER_LIFE
  slot.life = TRACER_LIFE
  mesh.visible = true
}

/** Shared muzzle flash (gun barrel) — single instance, retriggered per shot. */
export const muzzleFlash = (x, y, z) => {
  if (!flashMesh.current) return
  flashMesh.current.position.set(x, y, z)
  flashTTL = FLASH_LIFE
  flashMesh.current.visible = true
  if (flashLight.current) flashLight.current.position.set(x, y, z)
}

/** Small spark where a bullet hits a wall / the ground. */
export const impactFlash = (x, y, z) => {
  if (!impactMesh.current) return
  impactMesh.current.position.set(x, y, z)
  impactTTL = FLASH_LIFE
  impactMesh.current.visible = true
}

// Refs live at module scope so the fire helpers above can reach the meshes
// before/without the component being rendered (they no-op when absent).
const flashMesh = { current: null }
const flashLight = { current: null }
const impactMesh = { current: null }

export const BulletFx = () => {
  const refs = useRef([])

  useFrame((_, delta) => {
    let anyTTL = false
    for (let i = 0; i < TRACER_POOL; i += 1) {
      const s = slots[i]
      const mesh = s.mesh
      if (!mesh) continue
      if (s.ttl > 0) {
        s.ttl -= delta
        const k = Math.max(0, s.ttl / s.life)
        mesh.material.opacity = k
        if (s.ttl <= 0) mesh.visible = false
        anyTTL = true
      }
    }
    if (flashTTL > 0 && flashMesh.current) {
      flashTTL -= delta
      const k = Math.max(0, flashTTL / FLASH_LIFE)
      flashMesh.current.material.opacity = k
      if (flashLight.current) flashLight.current.intensity = k * 3
      if (flashTTL <= 0) {
        flashMesh.current.visible = false
        if (flashLight.current) flashLight.current.intensity = 0
      }
    }
    if (impactTTL > 0 && impactMesh.current) {
      impactTTL -= delta
      const k = Math.max(0, impactTTL / FLASH_LIFE)
      impactMesh.current.material.opacity = k
      if (impactTTL <= 0) impactMesh.current.visible = false
    }
    return anyTTL
  })

  return (
    <>
      {slots.map((s, i) => (
        <mesh
          key={i}
          ref={(m) => {
            refs.current[i] = m
            s.mesh = m
          }}
          visible={false}
          frustumCulled={false}
        >
          <boxGeometry args={[0.03, 0.03, 1]} />
          <meshBasicMaterial color="#ffd75e" transparent opacity={1} depthWrite={false} />
        </mesh>
      ))}
      {/* Muzzle flash: small bright octahedron + a short-lived point light */}
      <mesh
        ref={(m) => { flashMesh.current = m }}
        visible={false}
        frustumCulled={false}
      >
        <octahedronGeometry args={[0.09, 0]} />
        <meshBasicMaterial color="#ffe9a0" transparent opacity={1} depthWrite={false} />
      </mesh>
      <pointLight
        ref={(l) => { flashLight.current = l }}
        color="#ffcf6e"
        intensity={0}
        distance={7}
        decay={2}
      />
      {/* Wall/ground impact spark */}
      <mesh
        ref={(m) => { impactMesh.current = m }}
        visible={false}
        frustumCulled={false}
      >
        <octahedronGeometry args={[0.06, 0]} />
        <meshBasicMaterial color="#dfe7ff" transparent opacity={1} depthWrite={false} />
      </mesh>
    </>
  )
}

export default BulletFx