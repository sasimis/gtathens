import { IMPACT_CONCRETE, IMPACT_DUST, IMPACT_METAL } from '../BulletFx'
import { CAR_LIVE_POS, crash } from '../Car'

// Result of a world raycast (module scratch — reused by every cast).
export const worldHit = { hit: false, toi: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, handle: -1 }

/** The player's own collider handle — keeps the camera ray off our own back. */
export const selfColliderHandle = (bodyRef) => {
  const b = bodyRef && bodyRef.current
  if (!b || typeof b.collider !== 'function') return -1
  try {
    const c = b.collider(0)
    if (c && typeof c.handle === 'number') return c.handle
  } catch (e) { /* noop */ }
  return -1
}

/**
 * World raycast into the shared `worldHit` scratch. Two passes at most: the
 * camera sits behind the player, so the first hit can be the shooter's own
 * capsule — the ray is then resumed 0.35 m past it.
 */
export const castWorld = (world, rapier, ox, oy, oz, dx, dy, dz, maxToi, skipHandle) => {
  worldHit.hit = false
  let x = ox
  let y = oy
  let z = oz
  let left = maxToi
  for (let pass = 0; pass < 2; pass += 1) {
    let ray = null
    try {
      ray = new rapier.Ray({ x, y, z }, { x: dx, y: dy, z: dz })
    } catch (e) {
      return false
    }
    let res = null
    try {
      res = typeof world.castRayAndGetNormal === 'function'
        ? world.castRayAndGetNormal(ray, left, true)
        : world.castRay(ray, left, true)
    } catch (e) {
      res = null
    }
    try { if (ray && typeof ray.free === 'function') ray.free() } catch (e) { /* noop */ }
    if (!res) return false
    const toi = res.toi ?? res.timeOfImpact ?? left
    const handle =
      res.collider && typeof res.collider.handle === 'number' ? res.collider.handle : -1
    if (pass === 0 && skipHandle >= 0 && handle === skipHandle) {
      const adv = toi + 0.35
      if (adv >= left) return false
      x += dx * adv
      y += dy * adv
      z += dz * adv
      left -= adv
      continue
    }
    const n = res.normal || null
    worldHit.toi = toi
    worldHit.x = x + dx * toi
    worldHit.y = y + dy * toi
    worldHit.z = z + dz * toi
    worldHit.nx = n ? n.x : -dx
    worldHit.ny = n ? n.y : -dy
    worldHit.nz = n ? n.z : -dz
    worldHit.handle = handle
    worldHit.hit = true
    return true
  }
  return false
}

const METAL_R2 = 2.4 * 2.4
export const nearCarXZ = (x, z) => {
  for (let i = 0; i < CAR_LIVE_POS.length; i += 1) {
    const p = CAR_LIVE_POS[i]
    if (!p) continue
    const dx = p.x - x
    const dz = p.z - z
    if (dx * dx + dz * dz < METAL_R2) return true
  }
  const ai = crash && crash.aiLive
  if (ai) {
    for (let i = 0; i < ai.length; i += 1) {
      const p = ai[i]
      if (!p || !Number.isFinite(p.x)) continue
      const dx = p.x - x
      const dz = p.z - z
      if (dx * dx + dz * dz < METAL_R2) return true
    }
  }
  return false
}

export const surfaceKind = (x, y, z) => {
  if (y < 0.35) return IMPACT_DUST
  if (nearCarXZ(x, z)) return IMPACT_METAL
  return IMPACT_CONCRETE
}
