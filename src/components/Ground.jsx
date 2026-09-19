import React, { useEffect, useState } from 'react'
import * as THREE from 'three'
import { RigidBody } from '@react-three/rapier'

// Collision groups (Rapier): bits 0-15 = membership, bits 16-31 = filter.
const GROUP_GROUND = 0x0001
const GROUND_COLLISION_GROUPS = GROUP_GROUND | (0x000f << 16) // ground collides with all

// Ground pavement = the EXACT reference photo (public/textures/tiles.jpg,
// 1600x1600 = a 4x4 grid of faceted off-white pillow slabs with wide dark
// blue-grey joints). It is used AS-IS: never re-bake, restyle, downscale or
// procedurally recreate it - swapping the plaza means dropping a replacement
// photo at this path. One image tile spans TILE_M world metres, so each slab
// in the photo's 4x4 grid is 2 m (the scale the plaza was authored at).
const PAVEMENT_URL = '/textures/tiles.jpg'
const TILE_M = 8
const WORLD_M = 4000
/**
 * Ground - the pavement plaza the whole city stands on.
 *
 * ONE mesh, ONE material: a box whose top face is exactly y=0 (the physics
 * collider, so feet/wheels rest on the visible surface), tiled 500x over the
 * map out of the single 1600px reference photo (8 m tile = 2 m slabs).
 * Joints + facet shading all live IN that photo - there is no overlay mesh.
 *
 * Do NOT add a second "detail" plane on top of this one, and never give the
 * ground a polygonOffset: the road ribbons sit only 3-6 cm above y=0, so with
 * the camera far plane at 4000 the depth buffer only resolves ~2 cm at 400 m
 * and a nearer-biased pavement overlay wins hundreds of metres out. Symptom:
 * roads vanish until you are almost on top of them. The bias belongs on the
 * ROADS (Roads.jsx), where polygonOffset pulls them toward the camera by a
 * fixed number of depth units at ANY distance.
 */
const Ground = () => {
  // The pavement photo is loaded imperatively (not useTexture/suspense) so a
  // missing /textures/tiles.jpg only falls back to a flat-colour plaza instead
  // of suspending -> error boundary -> black canvas.
  const [map, setMap] = useState(null)
  useEffect(() => {
    let alive = true
    new THREE.TextureLoader().load(
      PAVEMENT_URL,
      (tex) => {
        if (!alive) {
          tex.dispose()
          return
        }
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = THREE.RepeatWrapping
        tex.repeat.set(WORLD_M / TILE_M, WORLD_M / TILE_M)
        tex.anisotropy = 8
        if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace
        tex.needsUpdate = true
        setMap(tex)
      },
      undefined,
      () => {},
    )
    return () => {
      alive = false
    }
  }, [])

  return (
    <RigidBody type="fixed" colliders="cuboid" collisionGroups={GROUND_COLLISION_GROUPS}>
      {/* Walkable ground: top face exactly at y=0 so feet rest ON it. */}
      <mesh position={[0, -0.5, 0]} receiveShadow>
        <boxGeometry args={[WORLD_M, 1, WORLD_M]} />
        <meshStandardMaterial
          map={map}
          color={map ? '#ffffff' : '#7c868b'}
          roughness={0.95}
          metalness={0}
        />
      </mesh>
    </RigidBody>
  )
}

export default Ground