
import React, { useEffect, useMemo, useRef } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { normalizeId } from './utils/misc.js'

// The GLB pack (public/models/cars/*.glb) is authored in meters, Y-up, wheels
// resting on y=0 and the nose along +Z — but every export carries a showroom
// XZ offset (the models were laid out in a row before export), so the clone is
// re-centered on X/Z and snapped down to the ground here, once per load.
export const CarModel = React.memo(function CarModel({ id, damage = 0, seed = null }) {
  const file = normalizeId(id)
  const gltf = useGLTF(`/models/cars/${file}.glb`)

  // Clone once per load; clone materials once and keep original color so the
  // damage tint below never leaks into the shared drei cache.
  // metalness is zeroed because these GLBs omit `metallicFactor`, so the glTF
  // default 1.0 applies — a full metal with no scene.environment to reflect
  // renders near-black (measured black-on-asphalt from the GLB JSON chunk).
  // The material ARRAY-shape trap is handled below (see fixOne comment) — that
  // one is what actually made the cars invisible.
  const scene = useMemo(() => {
    const clone = gltf.scene.clone(true)
    const box = new THREE.Box3().setFromObject(clone)
    clone.position.x -= (box.min.x + box.max.x) / 2
    clone.position.z -= (box.min.z + box.max.z) / 2
    clone.position.y -= box.min.y
    clone.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
        if (!o.material) return
        const fixOne = (m) => {
          if (!m) return m
          const c = m.clone()
          if (typeof c.metalness === 'number') c.metalness = 0
          if (typeof c.roughness === 'number') c.roughness = Math.max(0.55, c.roughness)
          c.userData.originalColor = c.color ? c.color.clone() : null
          return c
        }
        // KEEP THE MATERIAL SHAPE: a single material must stay single. An
        // ARRAY material on a geometry with no `groups` makes three.js
        // projectObject() push ZERO render items — the mesh silently draws
        // nothing (scene graph, physics and enter-detection all keep working,
        // which is exactly why these cars were "there" but never visible).
        o.material = Array.isArray(o.material) ? o.material.map(fixOne) : fixOne(o.material)
      }
    })
    return clone
  }, [gltf])

  const wrapRef = useRef(null)

  useEffect(() => {
    const g = wrapRef.current
    if (!g) return
    const d = Math.min(1, Math.max(0, damage))
    g.scale.set(1 + d * 0.045, 1 - d * 0.11, 1 + d * 0.02)
    g.rotation.z = (seed?.r ?? 0) * d * 0.05
    g.rotation.x = (seed?.p ?? 0) * d * 0.04
    g.position.y = -d * 0.02
    const dim = 1 - 0.5 * d
    g.traverse((o) => {
      if (!o.isMesh || !o.material) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        if (m.userData.originalColor) {
          const oc = m.userData.originalColor
          m.color.setRGB(oc.r * dim, oc.g * dim, oc.b * dim)
        }
      }
    })
  }, [damage, seed])

  return (
    <group ref={wrapRef}>
      <primitive object={scene} />
    </group>
  )
})
