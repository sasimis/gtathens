// car-modules/CarWheels.jsx
// Procedural spinning wheels + brake lights for every car. The KayKit GLBs are
// a SINGLE merged mesh (1 node, 1 material — see carVisuals.js), so wheels and
// lights can't come from the model: they are overlay cylinders/boxes sized from
// the measured wheel arches in carVisuals.estimateWheels (extracted from the
// GLB vertex clouds). Zero per-frame allocation: wheel refs are read from
// arrays in useFrame, the shared brake-light material is mutated in place.
import React, { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { estimateWheels, getAnimSpot, getAnimAi } from './carVisuals.js'

// Module-level scratch — no allocation inside useFrame.
const AXIS_X = new THREE.Vector3(1, 0, 0)
// How fast wheels visually spin per m/s of car speed (rad/s per (m/s)).
const SPIN_PER_SPEED = 2.2
// Front wheels yaw with steering input (radians at full lock).
const STEER_VISUAL = 0.45

export const CarWheels = ({ half, carId, spotIndex = null, aiIndex = null }) => {
  const wheels = useMemo(() => estimateWheels(half, carId), [half, carId])
  // Front pair steers (pivot groups), all four spin (inner groups).
  const steerRefs = useRef([null, null])
  const spinRefs = useRef([null, null, null, null])
  const st = useRef({ ang: 0 })

  useFrame((_, delta) => {
    const dt = Math.min(0.05, delta || 0.016)
    const anim = spotIndex != null
      ? getAnimSpot(spotIndex)
      : aiIndex != null
        ? getAnimAi(aiIndex)
        : null
    const steer = anim ? (anim.steer || 0) : 0

    // Spin proportional to speed; direction follows the sign of speed.
    // Rolling forward (+Z) needs NEGATIVE rotation about +X (right-hand rule:
    // positive X-spin rolls the wheel toward -Z), so negate.
    st.current.ang -= (anim ? anim.speed : 0) * SPIN_PER_SPEED * dt
    const spin = st.current.ang
    for (let i = 0; i < 4; i += 1) {
      const g = spinRefs.current[i]
      if (g) g.quaternion.setFromAxisAngle(AXIS_X, spin)
    }
    // Front wheels (indices 0/1) yaw with steering.
    const sy = steer * STEER_VISUAL
    for (let i = 0; i < 2; i += 1) {
      const g = steerRefs.current[i]
      if (g) g.rotation.y = sy
    }
  })

  return (
    <group>
      {wheels.positions.map((w, i) => (
        <group
          key={i}
          position={[w.x, w.y, w.z]}
          ref={i < 2 ? (el) => { steerRefs.current[i] = el } : undefined}
        >
          <group ref={(el) => { spinRefs.current[i] = el }}>
            {/* Tire: dark cylinder, axis along X (rotated 90° about Z) */}
            <mesh rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[wheels.r, wheels.r, 0.18, 14]} />
              <meshStandardMaterial color="#141414" roughness={0.9} metalness={0} />
            </mesh>
            {/* Hub: light disc so the spin is actually visible */}
            <mesh rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[wheels.r * 0.45, wheels.r * 0.45, 0.19, 10]} />
              <meshStandardMaterial color="#8a8a8a" roughness={0.4} metalness={0.1} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  )
}
export default CarWheels