// car-modules/CarDebrisPool.jsx
// Pooled crash debris + dust: ONE instanced chunk mesh (48 boxes) + ONE
// instanced smoke puff mesh (24 billboard-ish spheres), mutated in place by
// draining the carVisuals debris queue. No per-hit allocation, never
// re-renders. Mount once inside <Physics> (App scene, next to ParkedCars).
import React, { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { drainDebris } from './carVisuals.js'

const CHUNKS = 48
const PUFFS = 24

const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()

export const CarDebrisPool = React.memo(function CarDebrisPool() {
  const chunkRef = useRef(null)
  const puffRef = useRef(null)
  const parts = useMemo(() => Array.from({ length: CHUNKS }, () => ({
    live: 0, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0, wx: 0, wz: 0, s: 1,
  })), [])
  const smoke = useMemo(() => Array.from({ length: PUFFS }, () => ({
    live: 0, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, s: 1,
  })), [])
  const ci = useRef(0)
  const pi = useRef(0)

  useFrame((st, delta) => {
    const dt = Math.min(0.05, delta || 0.016)
    // Drain crash events into the pools (round-robin overwrite).
    drainDebris((x, y, z, vx, vy, vz, kind, n) => {
      if (kind === 2) {
        for (let k = 0; k < n; k += 1) {
          const p = smoke[pi.current]
          pi.current = (pi.current + 1) % PUFFS
          p.live = 1.4 + Math.random() * 0.8
          const jx = (Math.random() - 0.5) * 1.4
          const jz = (Math.random() - 0.5) * 1.4
          p.x = x + jx; p.y = y + Math.random() * 0.4; p.z = z + jz
          p.vx = vx * 0.25 + jx * 0.5; p.vy = vy * 0.3 + 0.7; p.vz = vz * 0.25 + jz * 0.5
          p.s = 0.7 + Math.random() * 0.9
        }
      } else {
        for (let k = 0; k < n; k += 1) {
          const c = parts[ci.current]
          ci.current = (ci.current + 1) % CHUNKS
          c.live = 2.2 + Math.random() * 1.2
          const jx = (Math.random() - 0.5) * 1.2
          const jz = (Math.random() - 0.5) * 1.2
          c.x = x + jx; c.y = y + Math.random() * 0.3; c.z = z + jz
          c.vx = vx * (0.5 + Math.random() * 0.6) + jx * 1.6
          c.vy = vy * (0.6 + Math.random() * 0.5)
          c.vz = vz * (0.5 + Math.random() * 0.6) + jz * 1.6
          c.rx = Math.random() * Math.PI; c.rz = Math.random() * Math.PI
          c.wx = (Math.random() - 0.5) * 14; c.wz = (Math.random() - 0.5) * 14
          c.s = 0.6 + Math.random() * 0.9
        }
      }
    })
    // Integrate chunks (gravity + ground bounce at y=0.1).
    const cm = chunkRef.current
    if (cm) {
      for (let i = 0; i < CHUNKS; i += 1) {
        const c = parts[i]
        if (c.live > 0) {
          c.live -= dt
          c.vy -= 18 * dt
          c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt
          c.rx += c.wx * dt; c.rz += c.wz * dt
          if (c.y < 0.1) {
            c.y = 0.1
            c.vy = Math.abs(c.vy) * 0.35
            c.vx *= 0.6; c.vz *= 0.6; c.wx *= 0.6; c.wz *= 0.6
          }
          if (c.live <= 0) { c.y = -50 }
        }
        _p.set(c.x, c.y, c.z)
        _e.set(c.rx, 0, c.rz)
        _q.setFromEuler(_e)
        const sc = c.live > 0 ? 0.16 * c.s : 0.0001
        _s.set(sc, sc * 0.7, sc)
        _m.compose(_p, _q, _s)
        cm.setMatrixAt(i, _m)
      }
      cm.instanceMatrix.needsUpdate = true
    }
    // Integrate smoke (rise + expand + fade via scale; opacity is shared so
    // dead puffs park at scale ~0 underground).
    const pm = puffRef.current
    if (pm) {
      for (let i = 0; i < PUFFS; i += 1) {
        const p = smoke[i]
        if (p.live > 0) {
          p.live -= dt
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
          p.vy += 0.4 * dt
          p.s += dt * 1.1
          if (p.live <= 0) { p.y = -50 }
        }
        _p.set(p.x, p.y, p.z)
        _q.identity()
        const sc = p.live > 0 ? p.s : 0.0001
        _s.set(sc, sc, sc)
        _m.compose(_p, _q, _s)
        pm.setMatrixAt(i, _m)
      }
      pm.instanceMatrix.needsUpdate = true
    }
  })

  return (
    <group>
      <instancedMesh ref={chunkRef} args={[undefined, undefined, CHUNKS]} castShadow frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#2b2e33" roughness={0.85} metalness={0.25} />
      </instancedMesh>
      <instancedMesh ref={puffRef} args={[undefined, undefined, PUFFS]} frustumCulled={false}>
        <sphereGeometry args={[0.55, 8, 6]} />
        <meshStandardMaterial color="#9aa0a8" roughness={1} metalness={0} transparent opacity={0.42} depthWrite={false} />
      </instancedMesh>
    </group>
  )
})
export default CarDebrisPool
