// cityBounds.js - where the BUILT city ends.
//
// The map is a crop of Athens, but the ground plane is infinite (Ground.jsx
// draws a big flat grid), so anything that escapes the streets keeps driving
// forever on an empty plane until the city is a stripe on the horizon. This
// module is the single leash every moving thing obeys:
//
//   CarDriver (the car you are driving)  -> back to its own parking spot
//   AiCar       (traffic that lost its loop) -> back onto its route
//   Ped         (blind wander fallback)  -> back inside the spawn radius
//   PlayerBody  (on foot)                 -> back to the map spawn
//
// The number is measured from the real map_data.json, not guessed: the farthest
// BUILDING vertex is 463 m from the map spawn and ~95% of the ways sit inside
// 450 m, so 500 m is past the last block - the city never visibly ends before
// the leash - while stray footways (which reach 822 m) cannot drag anything
// out to the horizon.
export const CITY_LIMIT = 500

// Hard cap, used when a car has to be put back: keep it inside the limit.
export const cityLimit = () => CITY_LIMIT

/** True when a world XZ is off the map (or unreadable). */
export const outsideCity = (x, z) => (
  !Number.isFinite(x) || !Number.isFinite(z) || (x * x + z * z) > CITY_LIMIT * CITY_LIMIT
)

/** Nudges a point back inside the limit (used by the ped / player resets). */
export const clampToCity = (x, z, margin = 30) => {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { x: 0, z: 0 }
  const lim = Math.max(10, CITY_LIMIT - margin)
  const d = Math.hypot(x, z)
  if (d <= lim) return { x, z }
  const k = d > 0.0001 ? lim / d : 0
  return { x: x * k, z: z * k }
}

/** Leash telemetry (QA seam `window.__gtathensCity`): who got pulled back. */
export const CITY_LEASH = { car: 0, ai: 0, ped: 0, player: 0, last: null }

export const noteLeash = (who, x, z) => {
  if (who in CITY_LEASH) CITY_LEASH[who] += 1
  CITY_LEASH.last = { who, x, z, at: typeof performance !== 'undefined' ? performance.now() : 0 }
}

if (typeof window !== 'undefined') {
  window.__gtathensCity = {
    limit: CITY_LIMIT,
    counts: () => ({ ...CITY_LEASH }),
    last: () => (CITY_LEASH.last ? { ...CITY_LEASH.last } : null),
    outside: (x, z) => outsideCity(x, z),
  }
}
/**
 * QA teleport used by scripts/leash-probe.mjs: hurl the driven car, a traffic
 * car, a ped and the player far past the limit in one call, so the test can
 * prove the leash drags every one of them back. Game code never calls this.
 */
export const installLeashQA = (getBodies) => {
  if (typeof window === 'undefined') return
  window.__gtathensLeashFling = (dist = 900) => {
    const b = getBodies && getBodies()
    if (!b || !b.driven || !b.driven.rb) return 'no driven car'
    b.driven.rb.setTranslation({ x: dist, y: b.driven.y, z: dist }, true)
    b.driven.rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    return 'fling car'
  }
  window.__gtathensLeashFlingAll = (dist = 900) => {
    const b = getBodies && getBodies()
    if (!b) return 'no bodies'
    const out = []
    if (b.aiRb) { b.aiRb.setTranslation({ x: -dist, y: b.aiY, z: dist }, true); out.push('ai') }
    if (b.pedRb) { b.pedRb.setNextKinematicTranslation({ x: dist, y: 0.95, z: -dist }); out.push('ped') }
    if (b.playerRb) { b.playerRb.setTranslation({ x: -dist, y: b.playerY, z: -dist }, true); out.push('player') }
    return JSON.stringify({ flung: out })
  }
}