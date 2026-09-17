import React, { Suspense, useEffect, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Physics, RigidBody, useRapier } from '@react-three/rapier'
import City from './components/City'
import Player from './components/Player'
import Car, { ParkedCars, PLAYER_COLLISION_GROUPS } from './components/Car'
import MenuCamera from './components/MenuCamera'
import MenuRoot from './ui/MenuRoot'
import DayNightCycle from './components/DayNightCycle'
import DebugOverlay from './components/DebugOverlay'
import Npcs from './components/Npcs'
import CityNavMesh from './components/CityNavMesh'
import AudioSystem from './components/AudioSystem'
import Pickups from './components/Pickups'
import Inventory from './ui/Inventory'
import SickInventory from './ui/SickInventory'
import useGameStore, { Phase } from './store/useGameStore'
import './ui/ui.css'

// Collision groups (Rapier): bits 0-15 = membership, bits 16-31 = filter.
const GROUP_GROUND = 0x0001
const GROUP_BUILDING = 0x0008
const GROUND_COLLISION_GROUPS = GROUP_GROUND | (0x000F << 16) // ground collides with all

const DPR_BY_QUALITY = { low: 0.66, medium: 1, high: 1.75 }
const FOG_BY_QUALITY = { low: [120, 700], medium: [260, 1500], high: [320, 2600] }

/** Exposes the rapier world to the debug overlay (body/collider counts). */
const PhysicsProbe = () => {
  const { world } = useRapier()
  useEffect(() => {
    window.__gtathensPhysics = { world }
    return () => { delete window.__gtathensPhysics }
  }, [world])
  return null
}

/** Keeps the canvas camera FOV in sync with the graphics/camera settings. */
const FovSync = () => {
  const fov = useGameStore((s) => s.settings.fov)
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    camera.fov = fov
    camera.updateProjectionMatrix()
  }, [fov, camera])
  return null
}

const Scene = () => {
  const phase = useGameStore((s) => s.phase)
  const settingsReturn = useGameStore((s) => s.settingsReturn)
  const settings = useGameStore((s) => s.settings)
  const spawn = useGameStore((s) => s.spawn)
  const driving = useGameStore((s) => s.driving)
  // Browser debug: G toggles collider wireframes (Physics `debug` prop),
  // H toggles the stats strip. Wired via window.__gtathensSetColliders.
  const [showColliders, setShowColliders] = useState(false)
  useEffect(() => {
    window.__gtathensSetColliders = (v) =>
      setShowColliders((prev) => (typeof v === 'boolean' ? v : !prev))
    const onKey = (e) => {
      if (e.code === 'KeyG') setShowColliders((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      delete window.__gtathensSetColliders
    }
  }, [])

  const inGame =
    phase === Phase.PLAYING ||
    phase === Phase.PAUSED ||
    (phase === Phase.SETTINGS && settingsReturn === Phase.PAUSED)

  const menuCamActive =
    phase === Phase.MAIN_MENU ||
    (phase === Phase.SETTINGS && settingsReturn === Phase.MAIN_MENU)

  const fog = FOG_BY_QUALITY[settings.quality] ?? FOG_BY_QUALITY.high
  const sp = spawn ?? [0, 0]

  return (
    <>
      <FovSync />
      <MenuCamera active={menuCamActive} />
      <DayNightCycle shadows={settings.shadows} />
      <fog attach="fog" args={['#cfe0ef', fog[0], fog[1]]} />

      <Suspense fallback={null}>
        <Physics
          gravity={[0, -30, 0]}
          timeStep="vary"
          paused={phase !== Phase.PLAYING}
          debug={showColliders}
        >
          <PhysicsProbe />
          <City />

          {/* Walkable ground: top face exactly at y=0 so feet rest ON it. */}
          <RigidBody type="fixed" colliders="cuboid" collisionGroups={GROUND_COLLISION_GROUPS}>
            <mesh position={[0, -0.5, 0]} receiveShadow>
              <boxGeometry args={[4000, 1, 4000]} />
              <meshStandardMaterial color="#7d8f5e" />
            </mesh>
          </RigidBody>

          {/* The on-foot player - unmounted the moment you climb into a car
              (the driven car then owns the follow camera + input). MUST be
              `driving === null`, never `!driving`: `driving` is a car INDEX,
              and `!0` is true — entering car 0 used to leave the on-foot
              player mounted (two camera rigs fighting, double input) and its
              clearRespawn effect ate the exit handoff, dropping the character
              at the map spawn instead of beside the car it just left
              ("character separated from the car" + F prompt never showing). */}
          {inGame && driving === null && <Player key="player" />}

          {inGame && (
            <>
              {/* The Rgsdev cars YOU added — full pack parked on real OSM
                  streets near the spawn. Walk up + press F to drive any of
                  them; WASD to steer, F to hop back out. */}
              <ParkedCars spawn={sp} count={26} radius={280} />
              <Npcs spawn={sp} />
              <Pickups spawn={sp} />
              {/* Ped navmesh tile (null render): ground + building prisms from
                  the real OSM footprints. Peds wander via navRuntime; cars
                  keep the road graph (lib/RoadPathfinder.js). Fails soft. */}
              <CityNavMesh center={sp} />
            </>
          )}
          <DebugOverlay />
          <AudioSystem />
        </Physics>
      </Suspense>
    </>
  )
}

const App = () => {
  const shadows = useGameStore((s) => s.settings.shadows)
  const quality = useGameStore((s) => s.settings.quality)

  useEffect(() => {
    let el = document.getElementById('gtathens-debug')
    if (!el) {
      el = document.createElement('div')
      el.id = 'gtathens-debug'
      document.body.appendChild(el)
    }
    el.style.display = 'none'
    return () => { const n = document.getElementById('gtathens-debug'); if (n) n.remove() }
  }, [])

  const toggleDebug = () => {
    if (window.__gtathensDebug) window.__gtathensDebug.toggle()
  }
  const toggleColliders = () => {
    if (window.__gtathensDebug) window.__gtathensDebug.colliders()
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'black' }}>
      <Canvas
        shadows={shadows}
        dpr={DPR_BY_QUALITY[quality] ?? DPR_BY_QUALITY.high}
        camera={{ position: [340, 210, 0], fov: 68, near: 0.5, far: 4000 }}
      >
        <Scene />
      </Canvas>
      <div className="debug-buttons">
        <button onClick={toggleDebug} title="FPS / memory / physics stats (H)">DEBUG</button>
        <button onClick={toggleColliders} title="Show collision shapes (G)">HITBOX</button>
      </div>
      <MenuRoot />
      <Inventory />
      <SickInventory />
    </div>
  )
}

export default App

