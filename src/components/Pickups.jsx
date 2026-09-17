// World pickups: money stacks, ammo boxes, medkits and free weapons.
//
// Static pickups are laid out deterministically per map spawn (same recipe as
// the parking spots): points sampled along walkable OSM ways near the spawn,
// rejected inside building footprints. Killed NPCs drop cash/ammo via
// spawnDrop(); drops live for a while, then vanish.
//
// Collection is automatic on proximity (GTA-style) and works on foot and in a
// car (bigger radius). All per-frame work reuses module scratch — no
// allocations in useFrame.
import React, { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { WEAPONS } from '../lib/weapons'
import { audio } from '../lib/audio'
import {
  buildingPolygons,
  hash01,
  loadWorldData,
  pointInPolygon,
  roadPolyline,
  WALKABLE,
} from '../lib/worldData'
import useGameStore, { Phase } from '../store/useGameStore'
import { CAR_LIVE_POS } from './Car'
import { WeaponModel } from './Weapon'

const COLLECT_RADIUS_SQ = 1.6 * 1.6
const COLLECT_RADIUS_DRIVE_SQ = 2.6 * 2.6
const DROP_TTL_MS = 45000
const SCAN_INTERVAL = 0.12
const SPAWN_RADIUS = 260

// --- module state -----------------------------------------------------------
// Static layout cache (same pattern as Car.jsx's spotsCache).
let staticCache = { key: null, value: [] }
// Every live pickup (static + drops), stable records mutated in place.
const ITEMS = []
let dropSeq = 0
// spawnDrop is registered by the mounted <Pickups> (React state owns drops).
let spawnDropImpl = null

/** Spawns a temporary drop (cash/ammo) at a world position. */
export const spawnDrop = (type, x, z, amount) => {
  if (spawnDropImpl) spawnDropImpl(type, x, z, amount)
}

const mkItem = (type, x, z, amount) => {
  const item = {
    id: `p${(dropSeq += 1)}`,
    type,
    amount,
    x,
    z,
    collected: false,
    drop: false,
    born: 0,
    phase: Math.random() * Math.PI * 2,
    ref: { current: null },
  }
  ITEMS.push(item)
  return item
}

// --- collection -------------------------------------------------------------
const collect = (item) => {
  const st = useGameStore.getState()
  item.collected = true
  audio.play(item.type === 'money' ? 'pickup-money' : 'pickup')
  const g = item.ref.current
  if (g) g.visible = false
  switch (item.type) {
    case 'money':
      st.addMoney(item.amount)
      st.pushToast(`+$${item.amount}`, 'money')
      break
    case 'medkit': {
      const healed = Math.min(100, st.health + 50) - st.health
      st.setHealth(st.health + healed)
      st.pushToast(healed > 0 ? `+${healed} HP` : 'Health full', 'health')
      break
    }
    case 'ammo': {
      // Ammo goes to the first owned gun; no gun yet -> it's spare cash.
      const gun = st.weapons[0]
      if (gun) {
        st.addAmmo(gun.id, item.amount)
        st.pushToast(`+${item.amount} ${WEAPONS[gun.id]?.name ?? ''} ammo`.trim(), 'ammo')
      } else {
        st.addMoney(10)
        st.pushToast('+$10 (sold ammo)', 'money')
      }
      break
    }
    default: {
      const def = WEAPONS[item.type]
      if (def) {
        st.giveWeapon(item.type, def.pickupAmmo ?? 0)
        st.pushToast(`+ ${def.name}`, 'weapon')
      }
      break
    }
  }
}

// Anchor = the player on foot, or the car being driven (drive-over pickups).
const playerScratch = { x: 0, z: 0 }
const readAnchor = () => {
  const st = useGameStore.getState()
  if (st.driving !== null) {
    const lp = CAR_LIVE_POS[st.driving]
    if (!lp) return false
    playerScratch.x = lp.x
    playerScratch.z = lp.z
    return true
  }
  const p = window.__gtathensPlayer
  if (!p) return false
  playerScratch.x = p.x
  playerScratch.z = p.z
  return true
}

// --- visuals ----------------------------------------------------------------
const PickupVisual = ({ item }) => {
  switch (item.type) {
    case 'money':
      return (
        <group position={[0, 0.45, 0]} rotation={[0, 0.6, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.36, 0.09, 0.22]} />
            <meshStandardMaterial color="#3fae4f" emissive="#1d7a2d" emissiveIntensity={0.55} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.056, 0]}>
            <boxGeometry args={[0.2, 0.012, 0.12]} />
            <meshStandardMaterial color="#d9efe0" roughness={0.8} />
          </mesh>
        </group>
      )
    case 'ammo':
      return (
        <group position={[0, 0.4, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.32, 0.24, 0.22]} />
            <meshStandardMaterial color="#4c5236" roughness={0.7} />
          </mesh>
          <mesh position={[0, 0.1, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.035, 0.035, 0.3, 6]} />
            <meshStandardMaterial color="#c9a227" metalness={0.6} roughness={0.35} />
          </mesh>
        </group>
      )
    case 'medkit':
      return (
        <group position={[0, 0.4, 0]}>
          <mesh castShadow>
            <boxGeometry args={[0.36, 0.26, 0.36]} />
            <meshStandardMaterial color="#e8e8e8" roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.135, 0]}>
            <boxGeometry args={[0.22, 0.012, 0.07]} />
            <meshStandardMaterial color="#d63a35" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.135, 0]}>
            <boxGeometry args={[0.07, 0.012, 0.22]} />
            <meshStandardMaterial color="#d63a35" roughness={0.5} />
          </mesh>
        </group>
      )
    default: {
      const def = WEAPONS[item.type]
      if (!def || def.melee) return null
      return (
        <group position={[0, 0.5, 0]} scale={1.6}>
          <WeaponModel id={item.type} />
        </group>
      )
    }
  }
}

const PickupEntry = ({ item }) => (
  <group
    ref={(g) => {
      item.ref.current = g
    }}
    position={[item.x, 0, item.z]}
  >
    <PickupVisual item={item} />
  </group>
)

// --- component --------------------------------------------------------------
const Pickups = ({ spawn = [0, 0] }) => {
  const key = `${Math.round(spawn[0] * 10)},${Math.round(spawn[1] * 10)}`
  const [, setVersion] = useState(0)
  const scanT = useRef(0)

  useEffect(() => {
    let cancelled = false
    loadWorldData()
      .then((data) => {
        if (cancelled) return
        if (staticCache.key !== key) {
          staticCache = { key, value: buildLayout(data, spawn) }
        }
        // A remount (menu round-trip) starts a fresh session, matching
        // ParkedCars' lifecycle.
        ITEMS.length = 0
        for (const s of staticCache.value) mkItem(s.type, s.x, s.z, s.amount)
        setVersion((v) => v + 1)
      })
      .catch((err) => console.error('pickups: map load failed', err))
    spawnDropImpl = (type, x, z, amount) => {
      mkItem(type, x, z, amount)
      const item = ITEMS[ITEMS.length - 1]
      item.drop = true
      item.born = performance.now()
      setVersion((v) => v + 1)
    }
    // QA seam: extend the module-level pickup hook with a DROP-specific
    // counter (proves a kill dropped loot). MERGED, never replaced - the
    // module-level part owns remaining/list/tpNearest.
    const qa = window.__gtathensPickups || (window.__gtathensPickups = {})
    qa.drops = () => ITEMS.reduce((n, it) => n + (it.drop && !it.collected ? 1 : 0), 0)
    return () => {
      cancelled = true
      spawnDropImpl = null
      if (window.__gtathensPickups) delete window.__gtathensPickups.drops
      ITEMS.length = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useFrame((state, delta) => {
    const st = useGameStore.getState()
    if (st.phase !== Phase.PLAYING) return
    const dt = Math.min(delta, 0.05)
    const t = state.clock.elapsedTime
    // Spin + bob every visible pickup (cheap: transform writes only).
    for (let i = 0; i < ITEMS.length; i += 1) {
      const item = ITEMS[i]
      if (item.collected) continue
      const g = item.ref.current
      if (!g) continue
      g.rotation.y += dt * 1.5
      g.position.y = Math.sin(t * 2 + item.phase) * 0.06
    }
    // Collect scan at a modest tick rate.
    scanT.current += dt
    if (scanT.current < SCAN_INTERVAL) return
    scanT.current = 0
    if (!readAnchor()) return
    const rSq = st.driving !== null ? COLLECT_RADIUS_DRIVE_SQ : COLLECT_RADIUS_SQ
    for (let i = 0; i < ITEMS.length; i += 1) {
      const item = ITEMS[i]
      if (item.collected) continue
      const dx = item.x - playerScratch.x
      const dz = item.z - playerScratch.z
      if (dx * dx + dz * dz < rSq) collect(item)
    }
    // Expire drops.
    const now = performance.now()
    for (let i = 0; i < ITEMS.length; i += 1) {
      const item = ITEMS[i]
      if (!item.drop || item.collected) continue
      if (now - item.born > DROP_TTL_MS) {
        const g = item.ref.current
        if (g) g.visible = false
        item.collected = true
      }
    }
  })

  return (
    <>
      {ITEMS.map((item) => (
        <PickupEntry key={item.id} item={item} />
      ))}
    </>
  )
}

// Deterministic layout near the spawn: 8 cash stacks, 3 ammo boxes, 2 medkits,
// 1 pistol (close), 1 SMG (farther out). Points sit on walkable ways, never
// inside buildings, never on the spawn tile.
const buildLayout = (data, spawn) => {
  const segs = []
  for (const road of data.roads || []) {
    if (!WALKABLE.has(road.type)) continue
    const pts = roadPolyline(road)
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [ax, az] = pts[i]
      const [bx, bz] = pts[i + 1]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 8 || len > 160) continue
      const mx = (ax + bx) / 2
      const mz = (az + bz) / 2
      if (Math.hypot(mx - spawn[0], mz - spawn[1]) > SPAWN_RADIUS) continue
      segs.push([ax, az, bx, bz, len])
    }
  }
  const polys = buildingPolygons(data)
  const out = []
  const tryPlace = (type, amount, seed, minD, maxD) => {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const seg = segs[Math.floor(hash01(seed * 7 + attempt * 13) * segs.length) % segs.length]
      if (!seg) return
      const [ax, az, bx, bz, len] = seg
      const t = 0.15 + hash01(seed * 31 + attempt * 3) * 0.7
      const px = ax + (bx - ax) * t
      const pz = az + (bz - az) * t
      const d = Math.hypot(px - spawn[0], pz - spawn[1])
      if (d < minD || d > maxD || d < 8) continue
      const side = hash01(seed * 5 + attempt) > 0.5 ? 1 : -1
      const x = px + ((bz - az) / len) * 1.3 * side
      const z = pz + (-(bx - ax) / len) * 1.3 * side
      let inside = false
      for (const poly of polys) {
        if (pointInPolygon(x, z, poly)) {
          inside = true
          break
        }
      }
      if (inside) continue
      out.push({ type, amount, x, z })
      return
    }
  }
  for (let i = 0; i < 8; i += 1) {
    tryPlace('money', 15 + Math.round(hash01(i * 3 + 11) * 65), 100 + i, 10, SPAWN_RADIUS)
  }
  for (let i = 0; i < 3; i += 1) tryPlace('ammo', i === 0 ? 36 : 24, 200 + i, 25, SPAWN_RADIUS)
  for (let i = 0; i < 2; i += 1) tryPlace('medkit', 0, 300 + i, 20, SPAWN_RADIUS)
  tryPlace('pistol', 0, 400, 18, 120)
  tryPlace('smg', 0, 401, 110, SPAWN_RADIUS)
  return out
}

// --- QA seam (scripts/smoke.mjs) --------------------------------------------
if (typeof window !== 'undefined') {
  window.__gtathensPickups = {
    remaining: () => ITEMS.reduce((n, it) => n + (it.collected ? 0 : 1), 0),
    list: () =>
      ITEMS.filter((it) => !it.collected)
        .slice(0, 8)
        .map((it) => ({ type: it.type, amount: it.amount, x: +it.x.toFixed(1), z: +it.z.toFixed(1) })),
    // Teleports the real player body onto the nearest uncollected pickup so
    // the automatic collect path runs for real.
    tpNearest: () => {
      const p = window.__gtathensPlayer
      if (!p) return null
      let best = null
      let bestD = Infinity
      for (const it of ITEMS) {
        if (it.collected) continue
        const d = Math.hypot(it.x - p.x, it.z - p.z)
        if (d < bestD) {
          bestD = d
          best = it
        }
      }
      const body = window.__gtathensPlayerBody && window.__gtathensPlayerBody.current
      if (!best || !body || typeof body.setTranslation !== 'function') return null
      body.setTranslation({ x: best.x, y: 1.3, z: best.z }, true)
      body.setLinvel({ x: 0, y: 0, z: 0 }, true)
      return { type: best.type, amount: best.amount, dist: +bestD.toFixed(2) }
    },
  }
}

export default Pickups