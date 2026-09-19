import React, { useMemo } from 'react'
import { ConvexHullCollider, RigidBody, TrimeshCollider } from '@react-three/rapier'
import { hullVerts } from './cityGeometry'

const GROUP_BUILDING = 0x0008
export const BUILDING_COLLISION_GROUPS = GROUP_BUILDING | (0x000F << 16)

export const BuildingColliders = ({ buildings }) => {
  const geoms = useMemo(
    () =>
      buildings.map((b) => {
        const g = hullVerts(b)
        return { key: b.x.toFixed(2) + ',' + b.z.toFixed(2), geom: g, x: b.x, z: b.z }
      }),
    [buildings],
  )
  return (
    <>
      {geoms.map(({ key, geom, x, z }) => {
        if (geom.kind === 'trimesh') {
          return (
            <RigidBody
              key={key}
              type="fixed"
              friction={1}
              collisionGroups={BUILDING_COLLISION_GROUPS}
              position={[x, 0, z]}
            >
              <TrimeshCollider args={[geom.verts, geom.indices]} />
            </RigidBody>
          )
        }
        return (
          <RigidBody
            key={key}
            type="fixed"
            friction={1}
            collisionGroups={BUILDING_COLLISION_GROUPS}
            position={[x, 0, z]}
          >
            <ConvexHullCollider args={[geom.verts]} />
          </RigidBody>
        )
      })}
    </>
  )
}
