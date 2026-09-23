// car-modules/CarAnim.jsx
// Per-car visual animation: crash shake only (suspension bounce was removed —
// read as a constant jitter/shake while driving). No procedural wheels/trim —
// spinning wheel overlays live in CarWheels.jsx. The KayKit GLBs already carry
// baked wheels; overlay discs sat OUTSIDE the body and read as floating parts,
// so this layer only does crash-shake body motion (zero per-frame allocation).
import React, { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { getAnimSpot } from './carVisuals.js'

export const CarAnim = React.memo(function CarAnim({ half, carId, damage, spotIndex, children }) {
  const bodyG = useRef(null)
  const shake = useRef(-1)
  const lastCrash = useRef(0)
  useFrame((st, delta) => {
    const g = bodyG.current
    if (!g) return
    const dt = Math.min(0.05, delta || 0.016)
    const anim = spotIndex != null ? getAnimSpot(spotIndex) : null
    const cAt = anim ? (anim.crashAt || 0) : 0
    if (cAt !== lastCrash.current) { lastCrash.current = cAt; shake.current = 0 }
    if (shake.current >= 0) {
      shake.current += dt
      const k = shake.current
      if (k > 0.6) {
        shake.current = -1
        // Settle back to exactly zero so a crash never leaves a pose offset.
        g.position.y = 0
        g.rotation.x = 0
        g.rotation.z = 0
      } else {
        const env = 1 - k / 0.6
        g.position.y = Math.sin(k * 90) * 0.05 * env
        g.rotation.x = Math.sin(k * 77) * 0.03 * env
        g.rotation.z = Math.sin(k * 83 + 0.7) * 0.03 * env
      }
    }
  })
  return (
    <group ref={bodyG}>
      {children}
    </group>
  )
})
export default CarAnim
