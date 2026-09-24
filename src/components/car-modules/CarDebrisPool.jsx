// car-modules/CarDebrisPool.jsx
// Pooled crash debris + dust: ONE instanced chunk mesh (48 boxes) + ONE
// instanced smoke puff mesh (24 billboard-ish spheres), mutated in place by
// draining the carVisuals debris queue. No per-hit allocation, never
// re-renders. Mount once inside <Physics> (App scene, next to ParkedCars).
// EXPLOSION (debris kind 3): a third instanced mesh is an additive FIRE pool
// (64 blobs, per-instance colour ramp white-hot -> orange -> ember dark) fed
// by the burst + lingering wreck-burn emitters, plus one flash/burn point
// light. Fire fades "for free" under additive blending as its colour reaches
// black — no shared-opacity tricks, no per-frame allocation.
import React, { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { drainDebris } from './carVisuals.js'

const CHUNKS = 48
const PUFFS = 24
const FIRES = 64 // explosion fireball + burn flames share this pool
const BURN_SLOTS = 3 // concurrent burning wrecks that keep emitting flames
const BURN_DUR = 4.5 // seconds a wreck keeps burning after the burst

const _m = new THREE.Matrix4()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _c = new THREE.Color()
// Fire colour ramp stops (module-level: never allocate a Color per frame).
const FIRE_A = new THREE.Color('#fff3c0')
const FIRE_B = new THREE.Color('#ff9d2a')
const FIRE_C = new THREE.Color('#ff4a12')
const FIRE_D = new THREE.Color('#380a02')
// Live flame count for the last finished frame — QA (window.__gtathensBoom.fire)
// and the burn-light level read it; written by the single pool instance.
let fireAlive = 0

export const CarDebrisPool = React.memo(function CarDebrisPool() {
  const chunkRef = useRef(null)
  const puffRef = useRef(null)
  const fireRef = useRef(null)
  const lightRef = useRef(null)
  const parts = useMemo(() => Array.from({ length: CHUNKS }, () => ({
    live: 0, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0, wx: 0, wz: 0, s: 1,
  })), [])
  const smoke = useMemo(() => Array.from({ length: PUFFS }, () => ({
    live: 0, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, s: 1, dark: 0,
  })), [])
  const flames = useMemo(() => Array.from({ length: FIRES }, () => ({
    life: 0, life0: 1, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, s0: 1, s1: 1.5, hot: 1,
  })), [])
  const burns = useMemo(() => Array.from({ length: BURN_SLOTS }, () => ({
    x: 0, y: 0, z: 0, left: 0, acc: 0,
  })), [])
  const ci = useRef(0)
  const pi = useRef(0)
  const fi = useRef(0)
  const bi = useRef(0)
  const flash = useRef(0) // 1 -> 0 decays the explosion light spike
  const lpos = useRef({ x: 0, y: 0, z: 0 }) // anchor of the last explosion

  // Prime the instanceColor buffers once (white = unchanged material colour)
  // and merge the LIVE fire probe into the crashManager QA seam — merge, never
  // replace (see the seam gotcha in AGENTS.md), and remove only our own key.
  useEffect(() => {
    const white = new THREE.Color(1, 1, 1)
    const prime = (mesh) => {
      if (!mesh || typeof mesh.setColorAt !== 'function' || mesh.instanceColor) return
      for (let i = 0; i < mesh.count; i += 1) mesh.setColorAt(i, white)
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      if (mesh.material) mesh.material.needsUpdate = true
    }
    prime(puffRef.current)
    prime(fireRef.current)
    if (typeof window !== 'undefined') {
      const boom = window.__gtathensBoom || (window.__gtathensBoom = {})
      boom.fire = () => fireAlive
    }
    return () => {
      if (typeof window !== 'undefined' && window.__gtathensBoom
        && typeof window.__gtathensBoom.fire === 'function') {
        delete window.__gtathensBoom.fire
      }
    }
  }, [])

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
          p.dark = 0 // crash smoke stays light-grey
        }
      } else if (kind === 3) {
        // EXPLOSION: fireball burst (n flames, round-robin overwrite so a full
        // pool still pops), dark smoke, thrown chunks, the flash light spike
        // and a lingering burn emitter so the wreck keeps burning afterwards.
        const burst = Math.max(8, n | 0)
        for (let k = 0; k < burst; k += 1) {
          const f = flames[fi.current]
          fi.current = (fi.current + 1) % FIRES
          const a = Math.random() * Math.PI * 2
          const r = 1.5 + Math.random() * 4.5
          f.life0 = f.life = 0.7 + Math.random() * 0.8
          f.x = x + (Math.random() - 0.5) * 1.2
          f.y = y + (Math.random() - 0.5) * 0.8
          f.z = z + (Math.random() - 0.5) * 1.2
          f.vx = Math.cos(a) * r
          f.vy = 1.5 + Math.random() * 4.0
          f.vz = Math.sin(a) * r
          f.s0 = 0.5 + Math.random() * 0.6
          f.s1 = f.s0 * (1.7 + Math.random() * 0.9)
          f.hot = 0.95 + Math.random() * 0.35
        }
        for (let k = 0; k < 10; k += 1) {
          const p = smoke[pi.current]
          pi.current = (pi.current + 1) % PUFFS
          const a = Math.random() * Math.PI * 2
          const rr = Math.random() * 1.4
          p.live = 2.6 + Math.random() * 1.6
          p.x = x + Math.cos(a) * rr; p.y = y + 0.5 + Math.random() * 1.4; p.z = z + Math.sin(a) * rr
          p.vx = Math.cos(a) * (0.6 + Math.random()); p.vy = 1.6 + Math.random() * 1.4; p.vz = Math.sin(a) * (0.6 + Math.random())
          p.s = 1.4 + Math.random() * 1.6
          p.dark = 1 // blast smoke is dark, not the light crash grey
        }
        for (let k = 0; k < 10; k += 1) {
          const c = parts[ci.current]
          ci.current = (ci.current + 1) % CHUNKS
          const a = Math.random() * Math.PI * 2
          const sp = 3 + Math.random() * 6
          c.live = 2.4 + Math.random() * 1.4
          c.x = x + (Math.random() - 0.5); c.y = y + (Math.random() - 0.5); c.z = z + (Math.random() - 0.5)
          c.vx = Math.cos(a) * sp
          c.vy = 3 + Math.random() * 5
          c.vz = Math.sin(a) * sp
          c.rx = Math.random() * Math.PI; c.rz = Math.random() * Math.PI
          c.wx = (Math.random() - 0.5) * 18; c.wz = (Math.random() - 0.5) * 18
          c.s = 0.8 + Math.random() * 1.1
        }
        flash.current = 1
        lpos.current.x = x; lpos.current.y = y + 0.4; lpos.current.z = z
        const b = burns[bi.current]
        bi.current = (bi.current + 1) % BURN_SLOTS
        b.x = x; b.y = Math.max(0.2, y - 0.3); b.z = z
        b.left = BURN_DUR; b.acc = 0
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
    // dead puffs park at scale ~0 underground). Per-instance tint: blast
    // smoke (dark=1) multiplies down to near-black, crash smoke stays white.
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
        if (p.live > 0) {
          if (p.dark > 0) { const w = 1 - 0.8 * p.dark; _c.setRGB(w, w, w) }
          else _c.setRGB(1, 1, 1)
          pm.setColorAt(i, _c)
        }
      }
      pm.instanceMatrix.needsUpdate = true
      if (pm.instanceColor) pm.instanceColor.needsUpdate = true
    }
    // Integrate fire (drag + buoyancy so the fireball rises and dissipates;
    // colour ramps white-hot -> orange -> ember dark, and additive blending
    // fades it out as the colour approaches black). Zero allocation: colours
    // come from module-level stops via one scratch Color.
    const fm = fireRef.current
    let alive = 0
    if (fm) {
      for (let i = 0; i < FIRES; i += 1) {
        const f = flames[i]
        const on = f.life > 0
        if (on) {
          f.life -= dt
          const drag = Math.max(0, 1 - 2.4 * dt)
          f.vx *= drag; f.vz *= drag
          f.vy = f.vy * drag + 5.5 * dt // flames buoy upward
          f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt
        }
        const lit = f.life > 0
        if (lit) {
          alive += 1
          const t = 1 - f.life / Math.max(0.001, f.life0)
          if (t < 0.25) _c.copy(FIRE_A).lerp(FIRE_B, t * 4)
          else if (t < 0.6) _c.copy(FIRE_B).lerp(FIRE_C, (t - 0.25) / 0.35)
          else _c.copy(FIRE_C).lerp(FIRE_D, (t - 0.6) / 0.4)
          _c.multiplyScalar(f.hot)
          fm.setColorAt(i, _c)
        } else if (f.y > -49) {
          f.y = -50 // park the dead slot out of sight once
        }
        _p.set(f.x, f.y, f.z)
        _q.identity()
        const t2 = lit ? 1 - f.life / Math.max(0.001, f.life0) : 1
        const sc = lit ? (f.s0 + (f.s1 - f.s0) * t2) * (1 - t2 * t2) : 0.0001
        _s.set(sc, sc, sc)
        _m.compose(_p, _q, _s)
        fm.setMatrixAt(i, _m)
      }
      fm.instanceMatrix.needsUpdate = true
      if (fm.instanceColor) fm.instanceColor.needsUpdate = true
    }
    fireAlive = alive
    // Lingering wreck burn: each active slot trickles small flames for
    // BURN_DUR seconds (rate tapers as the slot runs out). Round-robin
    // overwrite, and live burst flames are skipped so the fireball survives.
    let burnLv = 0
    for (let i = 0; i < BURN_SLOTS; i += 1) {
      const b = burns[i]
      if (b.left <= 0) continue
      b.left -= dt
      if (b.left > burnLv) burnLv = b.left
      b.acc += dt * (2 + 14 * Math.max(0, b.left) / BURN_DUR)
      let guard = 6 // hard cap per frame (belt + braces vs a dt spike)
      while (b.acc >= 1 && guard > 0) {
        b.acc -= 1
        guard -= 1
        const f = flames[fi.current]
        fi.current = (fi.current + 1) % FIRES
        if (f.life > 0) continue
        f.life0 = f.life = 0.45 + Math.random() * 0.6
        f.x = b.x + (Math.random() - 0.5) * 1.3
        f.y = b.y + Math.random() * 0.3
        f.z = b.z + (Math.random() - 0.5) * 1.3
        f.vx = (Math.random() - 0.5) * 0.8
        f.vy = 0.8 + Math.random() * 1.6
        f.vz = (Math.random() - 0.5) * 0.8
        f.s0 = 0.22 + Math.random() * 0.3
        f.s1 = f.s0 * (1.8 + Math.random() * 0.7)
        f.hot = 0.8 + Math.random() * 0.4
      }
    }
    // Explosion light: sharp flash spike at the boom + low flicker while any
    // wreck is still burning. One reusable pointLight, intensity only.
    const l = lightRef.current
    if (l) {
      if (flash.current > 0) flash.current = Math.max(0, flash.current - dt * 2.6)
      let inten = flash.current * flash.current * 90
      if (burnLv > 0) {
        const el = st.clock ? st.clock.elapsedTime : 0
        inten += 10 * Math.min(1, burnLv / 1.5) * (0.75 + 0.25 * Math.sin(el * 17))
      }
      l.intensity = inten
      if (inten > 0) l.position.set(lpos.current.x, lpos.current.y, lpos.current.z)
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
      {/* Explosion fire: additive glow blobs, per-instance colour ramp,
          tone-mapped off so the fireball stays searing against the scene. */}
      <instancedMesh ref={fireRef} args={[undefined, undefined, FIRES]} frustumCulled={false}>
        <sphereGeometry args={[0.5, 7, 5]} />
        <meshBasicMaterial
          color="#ffffff"
          toneMapped={false}
          transparent
          opacity={1}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </instancedMesh>
      {/* One reusable light: boom flash spike + wreck-burn flicker. */}
      <pointLight ref={lightRef} color="#ffb457" intensity={0} distance={30} decay={2} />
    </group>
  )
})
export default CarDebrisPool
