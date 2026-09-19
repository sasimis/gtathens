
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { CuboidCollider, RigidBody, useRapier } from '@react-three/rapier'
import { CAR_COLLISION_GROUPS, HALF, HIT_FORCE_MIN } from './constants.js'
import { crash, crashHitFromPayload, setRigidBodyType } from './crashManager.js'
import { normalizeId } from './utils/misc.js'
import { CarModel } from './CarModel.jsx'

export const Car = React.memo(function Car({
  id = 'sedan',
  position = [0, 0, 0],
  rotation = 0,
  dynamic = false,
  bodyRef = null,
  modelRef = null,
  spotIndex = null,
}) {
  const key = normalizeId(id)
  const rawHalf = HALF[key]
  const half = React.useMemo(() => [rawHalf[0] + 0.05, rawHalf[1] + 0.05, rawHalf[2] + 0.05], [rawHalf])
  // Live rapier module: `setRigidBodyType` prefers its RigidBodyType enum over
  // our numeric fallback, so a rapier upgrade can never silently reinterpret
  // the number as a different body type.
  const { rapier } = useRapier()
  const [dmg, setDmg] = useState(() => (spotIndex != null ? crash.damage[spotIndex] ?? 0 : 0))
  const dentSeed = useRef(null)
  if (!dentSeed.current) dentSeed.current = { r: Math.random() - 0.5, p: Math.random() - 0.5 }

  const onHit = useCallback((p) => crashHitFromPayload(p, spotIndex, false), [spotIndex])
  const onForce = useCallback((p) => crashHitFromPayload(p, spotIndex, true, p?.totalForceMagnitude ?? 0), [spotIndex])

  useEffect(() => {
    if (spotIndex == null || spotIndex < 0) return
    crash.setters[spotIndex] = setDmg
    return () => {
      if (crash.setters[spotIndex] === setDmg) crash.setters[spotIndex] = null
    }
  }, [spotIndex])

  useEffect(() => {
    if (spotIndex == null || spotIndex < 0) return undefined
    const rb = bodyRef?.current
    // Body may not exist on the first pass (RigidBody ref attaches after
    // mount) — retry next frame instead of registering nothing forever.
    if (!rb || typeof rb.translation !== 'function') {
      let alive = true
      let raf = 0
      const retry = () => {
        if (!alive) return
        const cur = bodyRef?.current
        if (cur && typeof cur.translation === 'function') {
          crash.bodies[spotIndex] = cur
          crash.bodyToSpot.set(cur, spotIndex)
          try {
            const col = typeof cur.collider === 'function' ? cur.collider(0) : null
            col?.setContactForceEventThreshold?.(HIT_FORCE_MIN)
          } catch {}
        } else {
          raf = requestAnimationFrame(retry)
        }
      }
      raf = requestAnimationFrame(retry)
      return () => { alive = false; cancelAnimationFrame(raf) }
    }
    crash.bodies[spotIndex] = rb
    crash.bodyToSpot.set(rb, spotIndex)
    try {
      const col = typeof rb.collider === 'function' ? rb.collider(0) : null
      col?.setContactForceEventThreshold?.(HIT_FORCE_MIN)
    } catch {}
    return () => {
      if (crash.bodies[spotIndex] === rb) crash.bodies[spotIndex] = undefined
      if (rb) crash.bodyToSpot.delete(rb)
    }
  }, [spotIndex, bodyRef])

  // Keep the SAME Rapier handle and toggle the type imperatively (see the
  // numeric-enum note in crashManager.js — a string here is what silently made
  // every parked car dynamic).
  useEffect(() => {
    setRigidBodyType(bodyRef?.current, dynamic ? 'dynamic' : 'fixed', rapier)
  }, [dynamic, bodyRef, rapier])

  return (
    <RigidBody
      ref={bodyRef}
      type="fixed"
      colliders={false}
      position={position}
      rotation={[0, rotation, 0]}
      collisionGroups={CAR_COLLISION_GROUPS}
      canSleep={false}
      linearDamping={0.2}
      angularDamping={0.1}
      onCollisionEnter={spotIndex != null ? onHit : undefined}
      onContactForce={spotIndex != null ? onForce : undefined}
    >
      <CuboidCollider args={half} position={[0, half[1], 0]} friction={0.7} density={40} restitution={0.20} />
      <group ref={modelRef}>
        <Suspense fallback={null}>
          <CarModel id={key} damage={dmg} seed={dentSeed.current} />
        </Suspense>
      </group>
    </RigidBody>
  )
})

export const CarByColor = ({ color, id, ...rest }) => {
  if (!id && typeof color === 'string') {
    const c = color.toLowerCase()
    if (c.includes('1565c0') || c.includes('blue')) id = 'sedan-blue'
    else if (c.includes('c62828') || c.includes('red')) id = 'muscle'
    else id = 'sedan'
  }
  return <Car id={id} {...rest} />
}
