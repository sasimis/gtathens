import React from 'react'
import { CuboidCollider, RigidBody } from '@react-three/rapier'

const GROUP_GROUND = 0x0001
const FILTER_ALL = 0x000f
const GROUND_COLLISION_GROUPS = GROUP_GROUND | (FILTER_ALL << 16)

export default function Ground() {
  return (
    <RigidBody type="fixed" collisionGroups={GROUND_COLLISION_GROUPS}>
      <CuboidCollider args={[2000, 1, 2000]} position={[0, -1, 0]} friction={0.8} restitution={0.1} />
      <mesh position={[0, -0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[4000, 4000]} />
        <meshStandardMaterial color="#2c3e50" roughness={0.8} metalness={0.1} />
      </mesh>
    </RigidBody>
  )
}
