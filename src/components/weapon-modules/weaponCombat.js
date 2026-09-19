import * as THREE from 'three'
import { WEAPONS } from '../../lib/weapons'
import {
  combat,
  noteHit,
  noteKill,
  ASSIST_CONE_DEG,
  TOUCH_HITBOX_SCALE,
} from '../../lib/combat'
import { pedRayHit, makeHit } from '../../lib/hitbox'
import {
  fireTracer,
  impactFlash,
  IMPACT_FLESH,
} from '../BulletFx'
import { NPC_RECORDS } from '../Npcs'
import { castWorld, selfColliderHandle, surfaceKind, worldHit } from './weaponRaycast'

export const AIM_MAX = 100
export const PED_GRACE = 0.35
export const FLINCH_TIME = 0.22

export const FISTS_DEF = { ...WEAPONS.fists, damage: 20, cooldown: 0.38, knockback: 1.6 }

const pedOut = makeHit()
const tmpV = new THREE.Vector3()

let reloadEl = null
export const setReloadUI = (pct) => {
  if (!reloadEl || !reloadEl.isConnected) reloadEl = document.getElementById('gtathens-reload')
  if (!reloadEl) return
  const on = pct > 0
  if (reloadEl.hidden === on) reloadEl.hidden = !on
  if (!on) return
  const fill = reloadEl.firstElementChild
  if (fill) fill.style.width = `${Math.round(Math.min(1, pct) * 100)}%`
}

export const shotTrace = {
  shots: 0, impacts: 0, hits: 0, x: 0, y: 0, z: 0, toi: -1, muzzle: 0,
  ox: 0, oy: 0, oz: 0, px: 0, py: 0, pz: 0,
  head: 0,
  kind: -1,
  pellets: 0,
  bloom: 0,
  assist: 0,
}

if (typeof window !== 'undefined') window.__gtathensShot = shotTrace

export const damagePed = (st, nr, kind, def, dirX, dirZ) => {
  const mul = kind === 2 ? (def.headshotMul || 2.5) : 1
  const dmg = Math.round((def.damage || 15) * mul)
  const now = performance.now()
  nr.hp = Math.max(0, nr.hp - dmg)
  nr.hurtAt = now
  nr.hurtKind = kind
  nr.flinchT = FLINCH_TIME
  nr.flinchX = -dirX
  nr.flinchZ = -dirZ
  nr.flinchSpeed = def.knockback || 1.2
  noteHit(kind, now)
  st.setHitAt(now, kind === 2)
  if (nr.hp <= 0) {
    nr.dead = true
    nr.deadAt = now
    nr.killer = 'player'
    st.addKill()
    noteKill(kind)
  }
}

export const applyAimAssist = (dir, ox, oy, oz, maxRange) => {
  if (!combat.assist) return false
  const cosMax = Math.cos((ASSIST_CONE_DEG * Math.PI) / 180)
  let best = -1
  let bestDot = cosMax
  for (let k = 0; k < NPC_RECORDS.length; k += 1) {
    const nr = NPC_RECORDS[k]
    if (!nr || nr.dead || !nr.rb || typeof nr.rb.translation !== 'function') continue
    let t = null
    try { t = nr.rb.translation() } catch (e) { continue }
    if (!t) continue
    tmpV.set(t.x - ox, t.y - oy, t.z - oz)
    const d = tmpV.length()
    if (d < 0.6 || d > maxRange) continue
    tmpV.multiplyScalar(1 / d)
    const dot = tmpV.x * dir.x + tmpV.y * dir.y + tmpV.z * dir.z
    if (dot > bestDot) {
      bestDot = dot
      best = k
    }
  }
  if (best < 0) return false
  const nr = NPC_RECORDS[best]
  let t = null
  try { t = nr.rb.translation() } catch (e) { return false }
  if (!t) return false
  const conf = Math.min(1, (bestDot - cosMax) / (1 - cosMax))
  const s = 0.35 + 0.5 * conf
  tmpV.set(t.x - ox, t.y + 0.1 - oy, t.z - oz)
  const d = tmpV.length() || 1
  tmpV.multiplyScalar(1 / d)
  dir.x = dir.x * (1 - s) + tmpV.x * s
  dir.y = dir.y * (1 - s) + tmpV.y * s
  dir.z = dir.z * (1 - s) + tmpV.z * s
  const l = Math.hypot(dir.x, dir.y, dir.z) || 1
  dir.x /= l
  dir.y /= l
  dir.z /= l
  return true
}

export const fireBullet = (ctx, st, def, ox, oy, oz, dx, dy, dz, fxOnce, damageOnce) => {
  const { world, rapier } = ctx
  const range = def.range || 90
  const hitSomething = castWorld(
    world, rapier, ox, oy, oz, dx, dy, dz, range, selfColliderHandle(ctx.bodyRef),
  )
  const wallT = hitSomething ? worldHit.toi : range

  let pedIdx = -1
  let pedKind = 0
  let pedT = Infinity
  const scale = combat.isTouch ? TOUCH_HITBOX_SCALE : 1
  for (let k = 0; k < NPC_RECORDS.length; k += 1) {
    const nr = NPC_RECORDS[k]
    if (!nr || nr.dead || !nr.rb || typeof nr.rb.translation !== 'function') continue
    let t = null
    try { t = nr.rb.translation() } catch (e) { continue }
    if (!t) continue
    if (!pedRayHit(ox, oy, oz, dx, dy, dz, range, t.x, t.y, t.z, scale, pedOut)) continue
    if (pedOut.t > wallT + PED_GRACE) continue
    if (pedOut.t < pedT) {
      pedT = pedOut.t
      pedIdx = k
      pedKind = pedOut.kind
    }
  }

  const wallFirst = hitSomething && wallT <= pedT
  const endT = wallFirst ? wallT : pedIdx >= 0 ? pedT : range
  const ex = ox + dx * endT
  const ey = oy + dy * endT
  const ez = oz + dz * endT
  const len = Math.hypot(ex - ox, ey - oy, ez - oz)
  const endX = len > 0.01 ? ex : ox + dx * 0.6
  const endY = len > 0.01 ? ey : oy + dy * 0.6
  const endZ = len > 0.01 ? ez : oz + dz * 0.6

  if (!fxOnce.tracer) fireTracer(ox, oy, oz, endX, endY, endZ)

  if (pedIdx >= 0 && !wallFirst) {
    impactFlash(pedOut.x, pedOut.y, pedOut.z, IMPACT_FLESH)
    shotTrace.x = pedOut.x
    shotTrace.y = pedOut.y
    shotTrace.z = pedOut.z
    shotTrace.toi = pedT
    shotTrace.kind = IMPACT_FLESH
    if (pedKind === 2) shotTrace.head = 1
    damageOnce.n = true
    shotTrace.hits += 1
    damagePed(st, NPC_RECORDS[pedIdx], pedKind, def, dx, dz)
  } else if (hitSomething) {
    const kind = surfaceKind(worldHit.x, worldHit.y, worldHit.z)
    impactFlash(worldHit.x, worldHit.y, worldHit.z, kind, worldHit.nx, worldHit.ny, worldHit.nz)
    shotTrace.x = worldHit.x
    shotTrace.y = worldHit.y
    shotTrace.z = worldHit.z
    shotTrace.toi = wallT
    shotTrace.kind = kind
    shotTrace.impacts += 1
  } else {
    shotTrace.toi = -1
    shotTrace.kind = -1
  }
}
