import React, { useEffect, useRef } from 'react'
import { RigidBody, CapsuleCollider, useRapier } from '@react-three/rapier'
import { useFrame } from '@react-three/fiber'
import { useKeyboardControls, KeyboardControls } from '@react-three/drei'
import * as THREE from 'three'
import useGameStore, { Phase } from '../store/useGameStore'
import Protagonist, { CHARACTERS } from './Protagonist'
import { CAR_LIVE_POS, PARK_COUNT, PARK_RADIUS, PLAYER_COLLISION_GROUPS, useParkingSpots, isOnAsphalt, crash } from './Car'
import { CameraRig, OrbitInput } from './FollowCamera'
import { BTN, getGamepad, padEdge, padHeld, readStick } from '../lib/gamepad'
import { audio } from '../lib/audio'
import WeaponController from './WeaponController'
import { BulletFx } from './BulletFx'

const ENTER_RANGE_SQ = 3.4 * 3.4
const ENTER_EXIT_RANGE_SQ = 4.2 * 4.2

const KEYBOARD_MAP = [
  { name: 'forward', keys: ['ArrowUp', 'KeyW'] },
  { name: 'backward', keys: ['ArrowDown', 'KeyS'] },
  { name: 'leftward', keys: ['ArrowLeft', 'KeyA'] },
  { name: 'rightward', keys: ['ArrowRight', 'KeyD'] },
  { name: 'jump', keys: ['Space'] },
  { name: 'run', keys: ['ShiftLeft', 'ShiftRight'] },
  { name: 'fire', keys: ['KeyX'] },
  { name: 'reload', keys: ['KeyR'] },
  { name: 'cycleNext', keys: ['KeyE'] },
  { name: 'cyclePrev', keys: ['KeyQ'] },
  { name: 'inventory', keys: ['KeyI'] },
]

const WALK_SPEED = 3.2
const RUN_SPEED = 6.6
const ACCEL = 16
const DAMPING = 10
const JUMP_V = 7.5
const CAPSULE_HALF = 0.6
const CAPSULE_RADIUS = 0.35
const COLLIDER_CENTER_Y = CAPSULE_HALF + CAPSULE_RADIUS
const FLOAT_HEIGHT = 0.02
const SPAWN_Y = COLLIDER_CENTER_Y + 0.3
const MODEL_Y = -COLLIDER_CENTER_Y
const CHARACTER_FACING_OFFSET = 0

const playerTrace = { x: 0, y: 0, z: 0, camYaw: 0, t: 0 }
if (typeof window !== 'undefined') window.__gtathensPlayer = playerTrace

const CarEntrance = ({ bodyRef, spots }) => {
  const phase = useGameStore((s) => s.phase)
  const setNearCar = useGameStore((s) => s.setNearCar)
  const setDriving = useGameStore((s) => s.setDriving)
  const driving = useGameStore((s) => s.driving)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const drivingRef = useRef(driving)
  drivingRef.current = driving
  const nearRef = useRef(-1)
  const mountedAt = useRef(performance.now())
  const pos = useRef(new THREE.Vector3())

  useEffect(() => {
    const timer = setInterval(() => {
      const body = bodyRef.current
      if (!body || typeof body.translation !== 'function') return
      if (phaseRef.current !== Phase.PLAYING) return
      if (drivingRef.current !== null) {
        if (nearRef.current !== -1) {
          nearRef.current = -1
          setNearCar(-1)
        }
        return
      }
      const t = body.translation()
      pos.current.set(t.x, t.y, t.z)
      const spotX = (i) => {
        const lp = CAR_LIVE_POS[i]
        return lp ? lp.x : spots[i].position[0]
      }
      const spotZ = (i) => {
        const lp = CAR_LIVE_POS[i]
        return lp ? lp.z : spots[i].position[2]
      }
      if (nearRef.current >= 0 && nearRef.current < spots.length
        && !crash.explodedParked.has(nearRef.current)) {
        const dx = pos.current.x - spotX(nearRef.current)
        const dz = pos.current.z - spotZ(nearRef.current)
        if (dx * dx + dz * dz < ENTER_EXIT_RANGE_SQ) return
      }
      let best = -1
      let bestD = ENTER_RANGE_SQ
      for (let i = 0; i < spots.length; i++) {
        if (crash.explodedParked.has(i)) continue // burning wreck — not enterable
        const dx = pos.current.x - spotX(i)
        const dz = pos.current.z - spotZ(i)
        const d = dx * dx + dz * dz
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best !== nearRef.current) {
        nearRef.current = best
        setNearCar(best)
      }
    }, 100)
    return () => {
      clearInterval(timer)
      nearRef.current = -1
      setNearCar(-1)
    }
  }, [bodyRef, spots, setNearCar])

  useEffect(() => {
    const onKey = (e) => {
      const isEnter = e.code === 'KeyF' || e.code === 'KeyY'
      if (!isEnter || e.repeat) return
      if (phaseRef.current !== Phase.PLAYING) return
      if (drivingRef.current !== null) return
      if (performance.now() - mountedAt.current < 350) return
      if (nearRef.current < 0) return
      setDriving(nearRef.current)
      audio.play('door')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setDriving])

  useEffect(() => {
    window.__gtathensCar = {
      count: spots.length,
      near: () => nearRef.current,
      spot: (i) => {
        const s = spots[i]
        return s ? { x: s.position[0], z: s.position[2] } : null
      },
      state: () => {
        const st = useGameStore.getState()
        return {
          driving: st.driving,
          nearCar: st.nearCar,
          respawn: st.respawn ? { x: st.respawn.x, z: st.respawn.z } : null,
        }
      },
      tp: (idx = 0) => {
        const body = bodyRef.current
        if (!body || typeof body.setTranslation !== 'function') return 'no body'
        const i = ((idx % spots.length) + spots.length) % spots.length
        const s = spots[i]
        body.setTranslation(
          { x: s.position[0] + 2.2, y: COLLIDER_CENTER_Y + FLOAT_HEIGHT, z: s.position[2] },
          true,
        )
        body.setLinvel({ x: 0, y: 0, z: 0 }, true)
        return i
      },
    }
    return () => { delete window.__gtathensCar }
  }, [bodyRef, spots])

  useFrame(() => {
    const pad = getGamepad()
    if (!pad) return
    if (phaseRef.current !== Phase.PLAYING) return
    if (drivingRef.current !== null) return
    if (performance.now() - mountedAt.current < 350) return
    if (nearRef.current < 0) return
    if (padEdge(pad, BTN.X) || padEdge(pad, BTN.LT)) {
      setDriving(nearRef.current)
    }
  })

  return null
}

const PlayerBody = ({ spawn }) => {
  const bodyRef = useRef(null)
  const modelRef = useRef(null)

  const [, getKeys] = useKeyboardControls()
  const { world, rapier } = useRapier()

  const vel = useRef(new THREE.Vector3())
  const stepT = useRef(0)
  const wasGrounded = useRef(true)

  const respawn = useGameStore((s) => s.respawn)
  const initialYaw = respawn?.yaw ?? Math.PI
  const yaw = useRef(initialYaw)
  const camYaw = useRef(initialYaw)

  const [action, setAction] = React.useState('idle')
  const [animSpeed, setAnimSpeed] = React.useState(1)

  const character = useGameStore((s) => s.character)
  const clearRespawn = useGameStore((s) => s.clearRespawn)
  const cycleCharacter = useGameStore((s) => s.cycleCharacter)

  const rp = respawn
  const spRef = useRef(null)
  if (spRef.current === null) {
    spRef.current = rp ? [rp.x, rp.z] : (spawn ?? [0, 0])
  }
  const sp = spRef.current
  const char = CHARACTERS[Math.abs(character) % CHARACTERS.length] ?? CHARACTERS[0]
  const spots = useParkingSpots(spawn ?? [0, 0], PARK_COUNT, PARK_RADIUS)

  useEffect(() => {
    if (respawn) clearRespawn()
  }, [respawn, clearRespawn])

  useEffect(() => {
    window.__gtathensTp = (x, z, facingYaw = null) => {
      const body = bodyRef.current
      if (!body || typeof body.setTranslation !== 'function') return 'no body'
      body.setTranslation({ x, y: COLLIDER_CENTER_Y + FLOAT_HEIGHT, z }, true)
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      if (Number.isFinite(facingYaw)) {
        camYaw.current = facingYaw
        yaw.current = facingYaw
      }
      return { x, z }
    }
    return () => { delete window.__gtathensTp }
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'KeyP' && !e.repeat) {
        cycleCharacter()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycleCharacter])

  useEffect(() => {
    let dragging = false
    let lastX = 0
    const down = (e) => { dragging = true; lastX = e.clientX }
    const move = (e) => {
      if (!dragging) return
      camYaw.current -= (e.clientX - lastX) * 0.004
      lastX = e.clientX
    }
    const up = () => { dragging = false }
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', up)
    }
  }, [])

  useFrame(({ camera }, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05)
    const keys = getKeys()
    const body = bodyRef.current

    const pad = getGamepad()
    let gpx = 0, gpz = 0
    let gpLookX = 0
    let gpJump = false
    let gpRun = false
    if (pad) {
      gpx = readStick(pad, 0)
      gpz = -readStick(pad, 1)
      gpLookX = readStick(pad, 2)
      gpJump = padEdge(pad, BTN.A)
      gpRun = padHeld(pad, BTN.LB) || padHeld(pad, BTN.RB)
      if (Math.abs(gpLookX) > 0.001) {
        camYaw.current -= gpLookX * 2.4 * dt
      }
      if (padEdge(pad, BTN.Y)) {
        // Y enters a nearby car when one is in reach; otherwise it still
        // cycles the character. (X / LT also enter — see CarEntrance.)
        const st = useGameStore.getState()
        if (st.phase === Phase.PLAYING && st.driving === null && st.nearCar >= 0 && performance.now() - mountedAt.current >= 350) {
          setDriving(st.nearCar)
          audio.play('door')
        } else {
          cycleCharacter()
        }
      }
    }

    let ix = (keys.rightward ? 1 : 0) - (keys.leftward ? 1 : 0) + gpx
    let iz = (keys.forward ? 1 : 0) - (keys.backward ? 1 : 0) + gpz
    const rawStrafe = (keys.rightward ? 1 : 0) - (keys.leftward ? 1 : 0) + gpx

    let mag = Math.hypot(ix, iz)
    if (mag > 1) {
      ix /= mag
      iz /= mag
      mag = 1
    }
    const moving = mag > 0.08
    const strafing = Math.max(-1, Math.min(1, rawStrafe))

    const sinC = Math.sin(camYaw.current)
    const cosC = Math.cos(camYaw.current)
    const dirX = iz * sinC - ix * cosC
    const dirZ = iz * cosC + ix * sinC

    const running = (keys.run || gpRun) && moving
    const targetSpeed = running ? RUN_SPEED : WALK_SPEED
    const targetX = dirX * targetSpeed * mag
    const targetZ = dirZ * targetSpeed * mag

    vel.current.x += (targetX - vel.current.x) * Math.min(1, ACCEL * dt)
    vel.current.z += (targetZ - vel.current.z) * Math.min(1, ACCEL * dt)
    if (!moving) {
      const damp = Math.exp(-DAMPING * dt)
      vel.current.x *= damp
      vel.current.z *= damp
    }

    let bodyPos = { x: sp[0], y: SPAWN_Y, z: sp[1] }
    let currentVel = { x: 0, y: 0, z: 0 }
    if (body && typeof body.translation === 'function') {
      bodyPos = body.translation()
    }
    if (body && typeof body.linvel === 'function') {
      currentVel = body.linvel()
    }

    const restY = COLLIDER_CENTER_Y + FLOAT_HEIGHT
    if (bodyPos.y < COLLIDER_CENTER_Y - 0.2) {
      body.setTranslation({ x: bodyPos.x, y: restY, z: bodyPos.z }, true)
      bodyPos = { x: bodyPos.x, y: restY, z: bodyPos.z }
      if (typeof body.setLinvel === 'function') {
        const lv = body.linvel()
        body.setLinvel({ x: lv.x, y: Math.max(0, lv.y), z: lv.z }, true)
        currentVel = { x: lv.x, y: Math.max(0, lv.y), z: lv.z }
      }
    }

    const grounded = bodyPos.y <= restY + 0.15 && currentVel.y <= 0.6

    // Landing thud check
    if (!wasGrounded.current && grounded) {
      audio.land(currentVel.y)
    }
    wasGrounded.current = grounded

    // Jump launch
    let vy = currentVel.y
    if (grounded && (keys.jump || gpJump)) {
      vy = JUMP_V
      audio.jump()
    }

    if (body && typeof body.setLinvel === 'function') {
      body.setLinvel({ x: vel.current.x, y: vy, z: vel.current.z }, true)
    }

    let moveYaw = yaw.current
    const planarSpeed = Math.hypot(vel.current.x, vel.current.z)
    if (planarSpeed > 0.4 && moving) {
      moveYaw = Math.atan2(vel.current.x, vel.current.z)
      const sideBias = strafing * (1 - Math.min(1, Math.abs(iz))) * 0.55
      moveYaw += sideBias
    } else if (!moving) {
      moveYaw = camYaw.current
    }
    let diff = moveYaw - yaw.current
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))
    yaw.current += diff * (1 - Math.exp(-10 * dt))

    // Footstep audio
    if (grounded && moving && planarSpeed > 0.6) {
      stepT.current += dt * (planarSpeed / WALK_SPEED)
      const interval = running ? 0.38 : 0.52
      if (stepT.current >= interval) {
        stepT.current = 0
        let onRoad = true
        try { onRoad = isOnAsphalt(bodyPos.x, bodyPos.z) } catch { /* assume asphalt */ }
        audio.stepSurface(onRoad, running)
      }
    } else {
      stepT.current = 0
    }

    if (modelRef.current) {
      modelRef.current.position.set(bodyPos.x, bodyPos.y + MODEL_Y, bodyPos.z)
      modelRef.current.rotation.y = yaw.current + CHARACTER_FACING_OFFSET
    }

    let next = 'idle'
    let speedMult = 1
    if (!grounded || vy > 2.0) {
      next = 'jump'
      speedMult = 1.1
    } else if (moving) {
      next = 'run'
      speedMult = running ? 1.4 : 0.75
    }
    setAction((prev) => (prev !== next ? next : prev))
    setAnimSpeed((prev) => (prev !== speedMult ? speedMult : prev))

    playerTrace.x = bodyPos.x
    playerTrace.y = bodyPos.y
    playerTrace.z = bodyPos.z
    playerTrace.camYaw = camYaw.current
    playerTrace.t = performance.now() | 0
  })

  return (
    <>
      <RigidBody
        ref={bodyRef}
        position={[sp[0], SPAWN_Y, sp[1]]}
        enabledRotations={[false, false, false]}
        type="dynamic"
        colliders={false}
        collisionGroups={PLAYER_COLLISION_GROUPS}
        mass={1}
        linearDamping={0.1}
        angularDamping={0}
        ccdEnabled
      >
        <CapsuleCollider
          args={[CAPSULE_HALF, CAPSULE_RADIUS]}
          friction={0.8}
          restitution={0}
        />
      </RigidBody>
      <group ref={modelRef}>
        <Protagonist action={action} skin={char.skin} animSpeed={animSpeed} />
        <WeaponController bodyRef={bodyRef} modelRef={modelRef} camYaw={camYaw} />
      </group>
      <CarEntrance bodyRef={bodyRef} spots={spots} />
      <BulletFx />
      <CameraRig bodyRef={bodyRef} modelRef={modelRef} lookHeight={1.3} yawRef={camYaw} />
      <OrbitInput />
    </>
  )
}

const Player = () => {
  const spawn = useGameStore((s) => s.spawn)
  const sp = spawn ?? [0, 0]
  return (
    <KeyboardControls map={KEYBOARD_MAP}>
      <PlayerBody spawn={sp} />
    </KeyboardControls>
  )
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (['Space'].includes(e.code)) e.preventDefault()
    },
    { passive: false },
  )
}

export default Player
