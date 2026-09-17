
import React, { useEffect, useMemo, useRef } from 'react'
import { useFBX } from '@react-three/drei'
import { UNIT } from './constants.js'
import { normalizeId } from './utils/misc.js'

export const CarModel = React.memo(function CarModel({ id, damage = 0, seed = null }) {
  const file = normalizeId(id)
  const fbx = useFBX(`/models/cars/${file}.fbx`)

  // Clone once per FBX, clone materials once and keep original color
  const scene = useMemo(() => {
    const clone = fbx.clone(true)
    clone.scale.setScalar(UNIT)
    clone.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.receiveShadow = true
        if (!o.material) return
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        o.material = mats.map((m) => {
          const c = m.clone()
          c.userData.originalColor = c.color.clone()
          return c
        })
      }
    })
    return clone
  }, [fbx])

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
