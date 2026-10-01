
import { GROUP_CAR, GROUP_BUILDING, HIT_SPEED_MIN, HIT_FORCE_MIN, HIT_DEBOUNCE_MS, PUSH_MIN, PUSH_MAX } from './constants.js'
import { audio } from '../../lib/audio'
import { pushDebris, animState, DEBRIS_EXPLOSION } from './carVisuals.js'

// Last crash event per spot: { at, speed, x, y, z } — CarAnim / CarDebrisPool
// poll this instead of subscribing, so crash FX never re-render React.

class CrashManager {
  damage = [] // number per spot 0..1
  loose = new Set()
  bodies = []
  bodyToSpot = new Map()
  setters = [] // React setState per spot
  lastHit = []
  lastAiHit = []
  looseSince = []
  livePos = [] // {x,z} mutable objects, zero alloc per frame
  aiBodies = [] // raw rapier body per AI traffic index (Npcs.jsx registers)
  aiLive = [] // stable {x,z} per AI car, mutated in place per frame
  aiDamage = [] // 0..1 per AI car (stolen-car HUD/engine parity)
  aiOccupied = new Set() // AI indices currently stolen by the player
  lastCrash = [] // { at, speed, x, y, z } per spot — crash FX poll target
  explodedParked = new Set() // spot indices whose damage hit 100% (one-shot boom)
  explodedAi = new Set() // AI traffic indices whose damage hit 100%
  explosions = 0 // total booms this session (QA: window.__gtathensBoom.count())
  lastExplosion = { at: 0, x: 0, y: 0, z: 0 } // stable record, mutated in place

  setLive(i, x, z) {
    if (!this.livePos[i]) this.livePos[i] = { x, z }
    else { this.livePos[i].x = x; this.livePos[i].z = z }
  }
  getLive(i) { return this.livePos[i] }
  setAiLive(i, x, z) {
    if (i == null || i < 0) return
    if (!this.aiLive[i]) this.aiLive[i] = { x, z }
    else { this.aiLive[i].x = x; this.aiLive[i].z = z }
  }
  getAiLive(i) { return this.aiLive[i] }
  /** Clears all crash/AI state (menu round-trip) so nothing leaks across remounts. */
  reset() {
    this.damage.length = 0
    this.loose.clear()
    this.bodies.length = 0
    this.bodyToSpot.clear()
    this.setters.length = 0
    this.lastHit.length = 0
    this.lastAiHit.length = 0
    this.looseSince.length = 0
    this.livePos.length = 0
    this.aiBodies.length = 0
    this.aiLive.length = 0
    this.aiDamage.length = 0
    this.aiOccupied.clear()
    this.explodedParked.clear()
    this.explodedAi.clear()
    this.explosions = 0
    this.lastExplosion.at = 0
    this.lastExplosion.x = 0
    this.lastExplosion.y = 0
    this.lastExplosion.z = 0
  }
}

export const crash = new CrashManager()

// Headless QA seam (scripts/smoke.mjs EXPLOSION TEST). CarDebrisPool MERGES
// its live `fire()` probe into this object on mount — extend it, never replace
// (see the seam-merge gotcha in AGENTS.md).
if (typeof window !== 'undefined') {
  window.__gtathensBoom = {
    count: () => crash.explosions,
    last: () => crash.lastExplosion,
    exploded: (sys, i) => (sys === 'ai' ? crash.explodedAi : crash.explodedParked).has(i),
  }
}

// Compat exports for old code that imports directly
export const CAR_LIVE_POS = crash.livePos
export const CAR_DAMAGE = crash.damage
export const spotsCache = { key: null, value: [] }
export const getCarBody = (i) => crash.bodies[i] ?? null
// AI traffic live state (registered by Npcs.jsx; read by Player/CarDriver).
export const AI_CAR_BODIES = crash.aiBodies
export const AI_CAR_LIVE = crash.aiLive
export const AI_CAR_DAMAGE = crash.aiDamage
export const isAiCarOccupied = (i) => crash.aiOccupied.has(i)
export const setAiCarOccupied = (i, v) => {
  if (v) crash.aiOccupied.add(i)
  else crash.aiOccupied.delete(i)
}
export const aiDamage = (i) => Math.min(1, crash.aiDamage[i] ?? 0)
export const addAiDamage = (i, amt) => {
  if (i == null || i < 0) return
  crash.aiDamage[i] = Math.min(1, (crash.aiDamage[i] ?? 0) + amt)
  if (crash.aiDamage[i] >= 1) explodeCar('ai', i)
}
// Road-surface helper (asphalt = fast, grass/dirt = slow). Roads.jsx publishes
// merged road segments into window.__gtathensRoadCache; a point is on asphalt
// when within half-width of a real segment. Throttled + zero alloc.
const SURF = { onRoad: false, checkedAt: 0 }
let surfX = Infinity
let surfZ = Infinity
export const isOnAsphalt = (x, z) => {
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (Math.hypot(x - surfX, z - surfZ) < 1.5 && now - SURF.checkedAt < 350) return SURF.onRoad
  surfX = x
  surfZ = z
  SURF.checkedAt = now
  let onRoad = false
  try {
    const segs = window.__gtathensRoadCache && window.__gtathensRoadCache.segs
    if (segs && segs.length) {
      for (let i = 0; i < segs.length; i += 1) {
        const s = segs[i]
        const dx = s.bx - s.ax
        const dz = s.bz - s.az
        const L2 = dx * dx + dz * dz
        let t = L2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / L2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const px = s.ax + dx * t - x
        const pz = s.az + dz * t - z
        const hw = Math.max((s.w || 6) / 2, ASPHALT_MIN_HALF_W) + 0.4
        if (px * px + pz * pz <= hw * hw) { onRoad = true; break }
      }
    }
  } catch (e) { /* noop */ }
  SURF.onRoad = onRoad
  return onRoad
}

// Minimum asphalt CORRIDOR half-width. The OSM ribbon widths are the painted
// carriageway (service 4.5 m, living_street 5.5 m, residential 6 m), but a car
// drives a corridor that ALSO covers its own footprint, the shoulder and the
// parking strip — parked cars sit 3.2 m off the centreline, so the raw
// half-width (2.25 m on a service road) reported "off asphalt" for cars parked
// on the street, and a car driving at a lane offset on a narrow street ate the
// 0.55x drag while visibly on tarmac. The corridor floor makes every drivable
// street count as asphalt while still leaving parks/plazas/fields off-road.
const ASPHALT_MIN_HALF_W = 5.0

export const isCarCollider = (c) => {
  try { return (c?.collisionGroups?.() & 0xffff & GROUP_CAR) !== 0 } catch { return false }
}

export const isBuildingCollider = (c) => {
  try { return (c?.collisionGroups?.() & 0xffff & GROUP_BUILDING) !== 0 } catch { return false }
}

// ---------------------------------------------------------------------------
// Car explosion — fires ONCE when a car's damage first reaches 100% (1.0).
// Event-driven only (called from addDamage / addAiDamage, never per frame):
// pumps one kind-3 event into the carVisuals debris queue (<CarDebrisPool>
// turns it into the fireball + dark smoke + flash light), plays the boom and
// records the QA state. The Sets make it idempotent — every later damage tick
// is a no-op because addDamage clamps at 1 and returns early.
// ---------------------------------------------------------------------------
const explodeCar = (sys, i) => {
  const set = sys === 'ai' ? crash.explodedAi : crash.explodedParked
  if (set.has(i)) return
  set.add(i)
  let x = 0, y = 0.6, z = 0
  try {
    if (sys === 'ai') {
      const rb = crash.aiBodies[i]
      if (rb && typeof rb.translation === 'function') {
        const t = rb.translation(); x = t.x; y = t.y + 0.5; z = t.z
      } else {
        const live = crash.aiLive[i]
        if (live) { x = live.x; z = live.z }
      }
    } else {
      const rb = crash.bodies[i]
      if (rb && typeof rb.translation === 'function') {
        const t = rb.translation(); x = t.x; y = t.y + 0.55; z = t.z
      } else {
        const lp = crash.livePos[i]
        if (lp) { x = lp.x; z = lp.z }
      }
    }
  } catch { /* keep the origin fallback */ }
  crash.explosions += 1
  const e = crash.lastExplosion
  e.at = typeof performance !== 'undefined' ? performance.now() : 0
  e.x = x; e.y = y; e.z = z
  try { pushDebris(x, y, z, 0, 0, 0, DEBRIS_EXPLOSION, 26) } catch { /* queue full */ }
  try { audio.explosion(1) } catch { /* fail-soft */ }
}

export const addDamage = (i, amount) => {
  if (i == null || i < 0) return
  const prev = crash.damage[i] ?? 0
  const next = Math.min(1, prev + amount)
  if (next === prev) return
  crash.damage[i] = next
  crash.setters[i]?.(next)
  if (next >= 1) explodeCar('parked', i)
}

// ---------------------------------------------------------------------------
// RigidBodyType — ALWAYS numeric, never a string
// ---------------------------------------------------------------------------
// rapier's raw API is `setBodyType(type: RigidBodyType, wakeUp)` where
// RigidBodyType is an ENUM (`Dynamic = 0, Fixed = 1, KinematicPositionBased = 2,
// KinematicVelocityBased = 3`). @react-three/rapier converts its own string
// prop through `rigidBodyTypeFromString()` before calling it for exactly this
// reason. Passing the string 'fixed' hits the WASM boundary as `0` => DYNAMIC,
// so a mount-time `setBodyType('fixed')` silently turned every parked car into
// a dynamic body: gravity sank them, the player could shove them, and the crash
// gate (`me.isFixed()`) could NEVER pass → "CRASH TEST: FAIL, damage=0.000"
// with the victim "moving" purely from gravity. Hence the numbers below.
export const RB_DYNAMIC = 0
export const RB_FIXED = 1
export const RB_KINEMATIC_POS = 2
export const RB_KINEMATIC_VEL = 3
const RB_BY_NAME = {
  dynamic: RB_DYNAMIC,
  fixed: RB_FIXED,
  kinematicPosition: RB_KINEMATIC_POS,
  kinematicVelocity: RB_KINEMATIC_VEL,
}
// In case rapier is ever swapped: prefer the live module's enum when the caller
// can hand it over (`useRapier().rapier`), else the values above.
const RB_ENUM_KEY = {
  dynamic: 'Dynamic',
  fixed: 'Fixed',
  kinematicPosition: 'KinematicPositionBased',
  kinematicVelocity: 'KinematicVelocityBased',
}

/**
 * Sets a raw rapier body's type from a name ('fixed' | 'dynamic' | ...).
 * No-ops when it is already that type (avoids pointless wake-ups). Returns
 * true when the body ends up in the requested state.
 */
export const setRigidBodyType = (rb, type, rapierModule = null) => {
  if (!rb || typeof rb.setBodyType !== 'function') return false
  let value = RB_BY_NAME[type]
  const enumObj = rapierModule && rapierModule.RigidBodyType
  const key = RB_ENUM_KEY[type]
  if (enumObj && key && typeof enumObj[key] === 'number') value = enumObj[key]
  if (typeof value !== 'number') return false
  try {
    if (typeof rb.bodyType === 'function' && rb.bodyType() === value) return true
    rb.setBodyType(value, true)
    return true
  } catch {
    return false
  }
}

// Records a crash FX event: lastCrash entry + pooled debris burst. Called
// from BOTH knock-loose and driven-car damage paths so every visible impact
// throws trim chunks and smoke, whether the victim was parked or driven.
const recordCrashFx = (i, me, other, speed, isBuilding) => {
  let px = 0, py = 0.8, pz = 0, dx = 0, dz = 0
  try {
    const t = me.translation ? me.translation() : null
    if (t) { px = t.x; py = t.y + 0.7; pz = t.z }
    const o = other && other.translation ? other.translation() : null
    if (t && o) {
      dx = t.x - o.x; dz = t.z - o.z
      const len = Math.hypot(dx, dz)
      if (len > 0.001) { dx /= len; dz /= len }
    }
  } catch {}
  try {
    crash.lastCrash[i] = { at: performance.now(), speed, x: px, y: py, z: pz }
    const a = animState.spots[i]
    if (a) { try { a.crashAt = performance.now() } catch { a.crashAt = 1 } }
  } catch {}
  const hard = Math.min(1, speed / 18)
  const n = 3 + Math.round(hard * 9)
  try {
    // Bumper/glass chunks fly along the separation axis, smoke hangs back.
    pushDebris(px, py, pz, dx * (2 + speed * 0.4), 2.2 + hard * 2, dz * (2 + speed * 0.4), isBuilding ? 0 : 1, n)
    pushDebris(px, py + 0.3, pz, -dx * 1.2, 1.1, -dz * 1.2, 2, 2 + Math.round(hard * 4))
  } catch {}
}

export const knockLoose = (i, me, other, speed) => {
  if (crash.loose.has(i)) return
  crash.loose.add(i)
  crash.looseSince[i] = performance.now()
  setRigidBodyType(me, 'dynamic')
  const t = me.translation()
  const o = other.translation()
  let dx = t.x - o.x, dz = t.z - o.z
  const len = Math.hypot(dx, dz)
  if (len < 0.001) {
    const lv = other.linvel(); dx = lv.x; dz = lv.z
  } else { dx /= len; dz /= len }
  const lv = other.linvel()
  const push = Math.min(PUSH_MAX, Math.max(PUSH_MIN, speed * 1.05))
  const spin = Math.max(-2.2, Math.min(2.2, (dz * lv.x - dx * lv.z) * 0.35))
  me.setLinvel({ x: dx * push, y: 0, z: dz * push }, true)
  me.setAngvel({ x: 0, y: spin, z: 0 }, true)
  addDamage(i, Math.min(0.4, 0.05 + speed * 0.022))
  const hitter = crash.bodyToSpot.get(other)
  if (hitter != null && hitter !== i) addDamage(hitter, Math.min(0.25, 0.03 + speed * 0.014))
}

export const crashHitFromPayload = (payload, spotIndex, viaForce, forceMag = 0, aiIndex = null) => {
  const me = payload?.target?.rigidBody
  const orb = payload?.other?.rigidBody
  if (!me) return

  // 1. Fixed car being hit by dynamic car (Parked car knock-loose path)
  if (typeof me.isFixed === 'function' && me.isFixed()) {
    if (!orb || typeof orb.isDynamic !== 'function' || !orb.isDynamic()) return
    if (!isCarCollider(payload.other?.collider)) return
    if (spotIndex == null || spotIndex < 0 || crash.loose.has(spotIndex)) return
    const lv = orb.linvel ? orb.linvel() : { x: 0, z: 0 }
    const speed = Math.hypot(lv.x, lv.z)
    if (speed < HIT_SPEED_MIN) return
    const now = performance.now()
    if (now - (crash.lastHit[spotIndex] ?? 0) < HIT_DEBOUNCE_MS) return
    if (viaForce && forceMag < HIT_FORCE_MIN) return
    crash.lastHit[spotIndex] = now
    audio.crash(speed / 30) // GTA-style thump, louder the harder the ram
    recordCrashFx(spotIndex, me, orb, speed, false)
    knockLoose(spotIndex, me, orb, speed)
    return
  }

  // 2. Dynamic / driven / loose car colliding with building, environment, AI traffic, or other cars
  if (spotIndex != null && spotIndex >= 0 && typeof me.isDynamic === 'function' && me.isDynamic()) {
    const lv = me.linvel ? me.linvel() : { x: 0, z: 0 }
    let speed = Math.hypot(lv.x, lv.z)
    if (orb && typeof orb.linvel === 'function') {
      const olv = orb.linvel()
      speed = Math.max(speed, Math.hypot(lv.x - olv.x, lv.z - olv.z))
    }
    if (speed < HIT_SPEED_MIN) return
    const now = performance.now()
    if (now - (crash.lastHit[spotIndex] ?? 0) < HIT_DEBOUNCE_MS) return
    if (viaForce && forceMag < HIT_FORCE_MIN) return

    const otherCol = payload.other?.collider
    const isBuilding = isBuildingCollider(otherCol)
    const isCar = isCarCollider(otherCol)

    if (isBuilding || isCar) {
      crash.lastHit[spotIndex] = now
      audio.crash(speed / 30)
      recordCrashFx(spotIndex, me, orb, speed, isBuilding && !isCar)
      const dmgAmt = Math.min(0.35, 0.04 + speed * 0.018)
      addDamage(spotIndex, dmgAmt)
    }
  }

  // 3. Dynamic AI car colliding with building, environment, or other cars
  if (aiIndex != null && aiIndex >= 0 && typeof me.isDynamic === 'function' && me.isDynamic()) {
    const lv = me.linvel ? me.linvel() : { x: 0, z: 0 }
    let speed = Math.hypot(lv.x, lv.z)
    if (orb && typeof orb.linvel === 'function') {
      const olv = orb.linvel()
      speed = Math.max(speed, Math.hypot(lv.x - olv.x, lv.z - olv.z))
    }
    if (speed < HIT_SPEED_MIN) return
    const now = performance.now()
    if (now - (crash.lastAiHit[aiIndex] ?? 0) < HIT_DEBOUNCE_MS) return
    if (viaForce && forceMag < HIT_FORCE_MIN) return

    const otherCol = payload.other?.collider
    const isBuilding = isBuildingCollider(otherCol)
    const isCar = isCarCollider(otherCol)

    if (isBuilding || isCar) {
      crash.lastAiHit[aiIndex] = now
      audio.crash(speed / 30)
      recordCrashFx(aiIndex, me, orb, speed, isBuilding && !isCar)
      const dmgAmt = Math.min(0.35, 0.04 + speed * 0.018)
      addAiDamage(aiIndex, dmgAmt)
    }
  }
}
