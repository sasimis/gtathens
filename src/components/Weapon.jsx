// Procedural low-poly guns + the mount that carries one on the character.
// The mount is a sibling of the <Protagonist> inside the model group, so it
// inherits the character's position + facing. It sits at the right hand's
// idle height and points +Z (the character's forward). Recoil is a tiny
// kick that decays every frame (gunFX.recoil, written by WeaponController).
import React, { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { buildGunModel, gunFX } from '../lib/weapons'

// Mount offset relative to the character's feet (model local space, meters).
const GUN_X = 0.27
const GUN_Y = 1.02
const GUN_Z = 0.1

/** A standalone floating gun (used by world pickups). */
export const WeaponModel = ({ id }) => {
  const model = useMemo(() => buildGunModel(id), [id])
  return <primitive object={model} />
}

/**
 * The gun the on-foot player is holding. Renders nothing for 'fists'.
 * Mounts itself at the right-hip carry position with the muzzle marker
 * exported through gunFX.getMuzzle so tracers can start at the barrel.
 */
export const GunMount = ({ weaponId }) => {
  const ref = useRef(null)
  const model = useMemo(() => buildGunModel(weaponId), [weaponId])

  useEffect(() => {
    gunFX.recoil = 0
    const muzzle = model.getObjectByName('muzzle')
    gunFX.getMuzzle = muzzle
      ? (out) => {
          muzzle.getWorldPosition(out)
          return true
        }
      : null
    return () => {
      gunFX.getMuzzle = null
      gunFX.recoil = 0
    }
  }, [model])

  useFrame((_, delta) => {
    // Decay the recoil kick (WeaponController spikes it on every shot).
    if (gunFX.recoil > 0) gunFX.recoil = Math.max(0, gunFX.recoil - delta * 7)
    const g = ref.current
    if (!g) return
    const r = gunFX.recoil
    g.rotation.x = -r * 0.55
    g.position.z = GUN_Z - r * 0.06
    g.position.y = GUN_Y + r * 0.012
  })

  return (
    <group ref={ref} position={[GUN_X, GUN_Y, GUN_Z]} rotation={[0.05, 0, 0]}>
      <primitive object={model} />
    </group>
  )
}

export default GunMount