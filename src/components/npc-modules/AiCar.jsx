import React, { Suspense, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import useGameStore, { Phase } from '../../store/useGameStore'
import { polylineLength, sampleRoute } from '../../lib/RoadPathfinder'
import { audio } from '../../lib/audio'
import { CarModel, crash, HALF, isOnAsphalt, setAiLive } from '../Car'
import { AI_CAR_GROUPS, AI_CRUISE } from './npcState'
import { computeAvoidSteer, findNearestOnRoute, getLookAheadTarget } from './aiTrafficUtils'

const AI_ACCEL_TAU = 2.5
const AI_RECOVER_DIST = 6
const MAX_STEER_ANGLE = 0.15
const AI_LOOK_AHEAD_DIST = 10
const OFF_ROAD_PENALTY_DIST = 4
const OFF_ROAD_SPEED_PENALTY = 0.4

export const AiCar = ({ route, seed, index = 0 }) => {
  const bodyRef = useRef(null)
  const gRef = useRef(null)
  const s = useRef({
    progress: 0,
    x: route[0][0],
    z: route[0][1],
    yaw: 0,
    speed: 0,
    totalLen: polylineLength(route),
    wobble: Math.random() * 100,
  })

  if (!crash.aiLive[index] || !Number.isFinite(crash.aiLive[index].x)) {
    crash.setAiLive(index, s.current.x, s.current.z)
  }

  const AI_CAR_IDS = [
    'sedan', 'sedan-blue', 'sedan-darkred',
    'sports', 'sports-yellow', 'sports-stripe',
    'muscle', 'muscle-black', 'muscle-green', 'muscle-teal',
    'suv', 'suv-black', 'suv-green', 'suv-teal',
    'suv-yellow', 'suv-blue', 'suv-orange', 'suv-red',
  ]
  const carId = AI_CAR_IDS[Math.abs(seed) % AI_CAR_IDS.length] || 'sedan'
  const half = HALF[carId] || HALF.sedan
  const cruiseMult = 0.9 + (Math.abs(seed) % 100) / 250
  const carCruise = AI_CRUISE * cruiseMult

  useFrame((state, dtRaw) => {
    const rb = bodyRef.current
    if (!rb || typeof rb.translation !== 'function') return
    const dt = Math.min(dtRaw, 0.05)
    const gs = useGameStore.getState()
    if (gs.phase !== Phase.PLAYING) {
      try { rb.setLinvel({ x: 0, y: 0, z: 0 }, true) } catch (e) { /* noop */ }
      return
    }

    const tPos = rb.translation()
    const currentX = tPos.x
    const currentZ = tPos.z

    s.current.x = currentX
    s.current.z = currentZ

    const currentRouteOut = { x: 0, z: 0, yaw: 0, done: false }
    sampleRoute(route, s.current.progress, currentRouteOut)

    if (currentRouteOut.done) {
      s.current.progress = 0
      sampleRoute(route, 0, currentRouteOut)
    }

    const lookAhead = getLookAheadTarget(
      route,
      s.current.progress,
      AI_LOOK_AHEAD_DIST + s.current.speed * 0.3,
      s.current.totalLen
    )

    let dx = lookAhead.x - currentX
    let dz = lookAhead.z - currentZ
    const desiredYaw = Math.atan2(dx, dz)

    let recoverAngle = 0
    let isOffCourse = false
    const distToRoute = Math.hypot(
      currentX - currentRouteOut.x,
      currentZ - currentRouteOut.z
    )

    if (distToRoute > AI_RECOVER_DIST * 0.5) {
      isOffCourse = true
      const nearest = findNearestOnRoute(route, currentX, currentZ)
      if (nearest && nearest.dist > 0.5) {
        const ndx = nearest.point[0] - currentX
        const ndz = nearest.point[1] - currentZ
        const nDist = Math.hypot(ndx, ndz)
        if (nDist > 0.1) {
          const recoverYaw = Math.atan2(ndx, ndz)
          let yawDiff = recoverYaw - s.current.yaw
          while (yawDiff > Math.PI) yawDiff -= Math.PI * 2
          while (yawDiff < -Math.PI) yawDiff += Math.PI * 2
          recoverAngle = yawDiff * 0.5
          s.current.speed *= 0.97
        }
      }
    }

    let wantSpeed = carCruise
    let offRoadPenalty = 1

    try {
      const onRoad = isOnAsphalt(currentX, currentZ)
      if (!onRoad) {
        offRoadPenalty = OFF_ROAD_SPEED_PENALTY
        const roadSegs = window.__gtathensRoadCache?.segs
        if (roadSegs && roadSegs.length > 0) {
          let nearestRoadX = currentX
          let nearestRoadZ = currentZ
          let nearestRoadDist = Infinity

          const sampleSteps = Math.min(roadSegs.length, 20)
          for (let i = 0; i < sampleSteps; i += 1) {
            const seg = roadSegs[i]
            const rdx = seg.bx - seg.ax
            const rdz = seg.bz - seg.az
            const L2 = rdx * rdx + rdz * rdz
            let t = L2 > 0 ? ((currentX - seg.ax) * rdx + (currentZ - seg.az) * rdz) / L2 : 0
            t = Math.max(0, Math.min(1, t))
            const px = seg.ax + rdx * t
            const pz = seg.az + rdz * t
            const d = Math.hypot(px - currentX, pz - currentZ)
            if (d < nearestRoadDist) {
              nearestRoadDist = d
              nearestRoadX = px
              nearestRoadZ = pz
            }
          }

          if (nearestRoadDist > OFF_ROAD_PENALTY_DIST) {
            const roadDx = nearestRoadX - currentX
            const roadDz = nearestRoadZ - currentZ
            const roadDir = Math.atan2(roadDx, roadDz)
            let roadYawDiff = roadDir - s.current.yaw
            while (roadYawDiff > Math.PI) roadYawDiff -= Math.PI * 2
            while (roadYawDiff < -Math.PI) roadYawDiff += Math.PI * 2

            recoverAngle += roadYawDiff * 0.4 * Math.min(1, nearestRoadDist / 10)
            isOffCourse = true
          }
        }
      }
    } catch { /* ignore */ }

    wantSpeed *= offRoadPenalty

    try {
      const p = window.__gtathensPlayer
      if (p) {
        const pd = Math.hypot(p.x - currentX, p.z - currentZ)
        if (pd < 5) wantSpeed = 0
        else if (pd < 10) wantSpeed = carCruise * 0.2 * offRoadPenalty
        else if (pd < 18) wantSpeed = carCruise * 0.5 * offRoadPenalty
        else if (pd < 25) wantSpeed = carCruise * 0.8 * offRoadPenalty
      }
    } catch { /* ignore */ }

    const others = crash.aiLive
    const [avoidX, avoidZ, imminentCollision] = computeAvoidSteer(
      currentX, currentZ, s.current.yaw, s.current.speed,
      others, index, route
    )

    let desiredYawWithAvoid = desiredYaw

    if (Math.abs(avoidX) > 0.01) {
      const steerAngle = Math.atan2(avoidX, 1) * 0.6
      desiredYawWithAvoid += steerAngle
    }

    if (Math.abs(recoverAngle) > 0.01) {
      desiredYawWithAvoid += recoverAngle
    }

    let yawDiff = desiredYawWithAvoid - s.current.yaw
    while (yawDiff > Math.PI) yawDiff -= Math.PI * 2
    while (yawDiff < -Math.PI) yawDiff += Math.PI * 2

    const proportional = yawDiff * 3.0
    const derivative = -s.current.speed * 0.02 * Math.sign(yawDiff)

    let maxTurn = MAX_STEER_ANGLE * (0.5 + s.current.speed * 0.03)
    maxTurn = Math.min(maxTurn, 0.15)

    if (isOffCourse) {
      maxTurn *= 1.3
    }

    if (imminentCollision) {
      wantSpeed *= 0.6
    }

    const steerInput = Math.max(-maxTurn, Math.min(maxTurn, proportional + derivative))
    s.current.yaw += steerInput * dt * 12

    const speedError = wantSpeed - s.current.speed
    s.current.speed += speedError * Math.min(1, dt * AI_ACCEL_TAU)
    s.current.speed = Math.max(0, s.current.speed)

    const dirX = Math.sin(s.current.yaw)
    const dirZ = Math.cos(s.current.yaw)
    const targetVx = dirX * s.current.speed
    const targetVz = dirZ * s.current.speed

    const v = rb.linvel ? rb.linvel() : { x: 0, y: 0, z: 0 }
    rb.setLinvel({ x: targetVx, y: v.y, z: targetVz }, true)

    const c = Math.cos(s.current.yaw / 2)
    const sinY = Math.sin(s.current.yaw / 2)
    rb.setRotation({ x: 0, y: sinY, z: 0, w: c }, true)

    const moveAlign = dirX * Math.sin(desiredYaw) + dirZ * Math.cos(desiredYaw)
    if (distToRoute < AI_RECOVER_DIST) {
      if (moveAlign > 0.3) {
        const progressRate = s.current.speed * dt * (0.8 + moveAlign * 0.2)
        s.current.progress += progressRate
        if (s.current.progress > s.current.totalLen) {
          s.current.progress -= s.current.totalLen
        }
      }
    } else {
      s.current.progress += s.current.speed * dt * 0.2
      if (s.current.progress > s.current.totalLen) {
        s.current.progress -= s.current.totalLen
      }
    }

    setAiLive(index, currentX, currentZ)
    try { crash.setAiLive(index, currentX, currentZ) } catch { /* seam not mounted */ }
    try {
      const live = crash.aiLive[index]
      if (live) {
        live.speed = s.current.speed
        live.yaw = s.current.yaw
      }
    } catch { /* ignore */ }

    if (gRef.current) {
      gRef.current.position.set(currentX, tPos.y - half[1], currentZ)
      gRef.current.rotation.set(0, s.current.yaw, 0)
    }
  })

  return (
    <group ref={gRef} position={[route[0][0], 0, route[0][1]]}>
      <RigidBody
        ref={bodyRef}
        type="dynamic"
        colliders={false}
        position={[route[0][0], half[1], route[0][1]]}
        collisionGroups={AI_CAR_GROUPS}
        mass={1800}
        canSleep={false}
        ccdEnabled
        linearDamping={0.5}
        angularDamping={2.0}
        onCollisionEnter={() => { try { audio.crash(0.3) } catch { /* ignore */ } }}
      >
        <CuboidCollider args={[half[0] + 0.05, half[1] + 0.05, half[2] + 0.05]} friction={0.7} restitution={0.20} />
      </RigidBody>
      <group position={[0, 0, 0]}>
        <Suspense fallback={null}>
          <CarModel id={carId} />
        </Suspense>
      </group>
    </group>
  )
}
