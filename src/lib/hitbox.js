// Cheap, analytic hitboxes for the shooting path.
//
// Why not the Rapier colliders: a ped's capsule IS in the physics world, but the
// shot ray has to answer "which ped, and was it the head?" — and the previous
// implementation guessed with a 1.6 m proximity sphere around the impact point,
// so grazing/leg shots either never registered or hit the wrong ped. These
// closed-form tests are exact for the shapes the peds actually use and cost a
// handful of flops, so we can run them against every ped on every shot.
//
// Ped collider (Npcs.jsx): <CapsuleCollider args={[0.6, 0.35]} /> on a body at
// y = 0.95 → cylinder from y = 0.35 to y = 1.55 with r = 0.35, i.e. the capsule
// is "all points within 0.35 m of the segment (y 0.35..1.55)".
//
// Everything writes into a caller-provided `out` object — no allocation.

export const PED_HALF = 0.6 // capsule half-height (excludes the caps)
export const PED_RADIUS = 0.35
export const PED_CENTER_Y = 0.95 // the ped body's translation is the chest
// Head sphere: sits on top of the cylinder (0.95 + 0.6 = 1.55) plus a little,
// with a slightly generous radius so a "face" shot reads as a headshot.
export const PED_HEAD_Y = 1.66
export const PED_HEAD_R = 0.24

export const BODY_HIT = 1
export const HEAD_HIT = 2

/** Fresh result object factory (used once per module-level scratch). */
export const makeHit = () => ({ hit: false, kind: 0, t: 0, x: 0, y: 0, z: 0 })

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Closest approach between the ray (origin O, unit dir D, t in [0, maxT]) and
 * the finite segment A→B. Writes the parameters into `params` ({t, s}) and
 * returns the squared distance between the two closest points.
 * Ericson, Real-Time Collision Detection §5.1.9 (closest point of two segments).
 */
export const raySegmentDistSq = (
  ox, oy, oz, dx, dy, dz, maxT,
  ax, ay, az, bx, by, bz,
  params,
) => {
  const abx = bx - ax
  const aby = by - ay
  const abz = bz - az
  const rx = ox - ax
  const ry = oy - ay
  const rz = oz - az
  // a = D·D = 1 (unit direction), e = AB·AB, b = D·AB, c = D·r, f = AB·r
  const e = abx * abx + aby * aby + abz * abz
  const b = dx * abx + dy * aby + dz * abz
  const c = dx * rx + dy * ry + dz * rz
  const f = abx * rx + aby * ry + abz * rz
  const denom = e - b * b // a = 1
  let s
  if (denom < 1e-9) {
    // Ray parallel to the capsule axis: any point on the axis works.
    s = 0
  } else {
    s = clamp01((f - b * c) / denom)
  }
  let t = b * s - c
  if (t < 0) {
    t = 0
    s = clamp01(f / (e || 1))
  } else if (t > maxT) {
    t = maxT
    s = clamp01((f + b * maxT) / (e || 1))
  }
  params.t = t
  params.s = s
  const px = ox + dx * t
  const py = oy + dy * t
  const pz = oz + dz * t
  const qx = ax + abx * s
  const qy = ay + aby * s
  const qz = az + abz * s
  const ex = px - qx
  const ey = py - qy
  const ez = pz - qz
  return ex * ex + ey * ey + ez * ez
}

/** Entry `t` of a ray into a sphere, or -1 when it misses / is behind. */
export const raySphere = (ox, oy, oz, dx, dy, dz, maxT, cx, cy, cz, r) => {
  const lx = ox - cx
  const ly = oy - cy
  const lz = oz - cz
  const b = lx * dx + ly * dy + lz * dz
  const c = lx * lx + ly * ly + lz * lz - r * r
  if (c > 0 && b > 0) return -1 // origin outside and pointing away
  const disc = b * b - c
  if (disc < 0) return -1
  const sq = Math.sqrt(disc)
  let t = -b - sq
  if (t < 0) t = -b + sq
  if (t < 0 || t > maxT) return -1
  return t
}

const params = { t: 0, s: 0 }

/**
 * Shoots one ped described by its body translation (cx, cy, cz) — the Rapier
 * capsule centre, i.e. chest height. Resolves head vs body and the surface
 * point, writing all of it into `out` (makeHit()). Returns true on a hit.
 * `scale` > 1 widens the hitboxes (touch/stick comfort, see TOUCH_HITBOX_SCALE).
 */
export const pedRayHit = (ox, oy, oz, dx, dy, dz, maxT, cx, cy, cz, scale, out) => {
  out.hit = false
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1

  // Head first: a shot that grazes the head sphere is a headshot even if the
  // body capsule would be entered a hair earlier — generous reads better.
  const th = raySphere(
    ox, oy, oz, dx, dy, dz, maxT,
    cx, cy + (PED_HEAD_Y - PED_CENTER_Y), cz, PED_HEAD_R * k,
  )
  if (th >= 0) {
    out.hit = true
    out.kind = HEAD_HIT
    out.t = th
    out.x = ox + dx * th
    out.y = oy + dy * th
    out.z = oz + dz * th
    return true
  }

  const r = PED_RADIUS * k
  const d2 = raySegmentDistSq(
    ox, oy, oz, dx, dy, dz, maxT,
    cx, cy - PED_HALF, cz, cx, cy + PED_HALF, cz,
    params,
  )
  if (d2 > r * r) return false

  // Surface point: from the axis point toward the ray point, pushed out by r.
  const t = params.t
  const px = ox + dx * t
  const py = oy + dy * t
  const pz = oz + dz * t
  const qy = cy - PED_HALF + params.s * (2 * PED_HALF)
  const ex = px - cx
  const ey = py - qy
  const ez = pz - cz
  const len = Math.hypot(ex, ey, ez) || 1
  out.hit = true
  out.kind = BODY_HIT
  out.t = t
  out.x = cx + (ex / len) * r
  out.y = qy + (ey / len) * r
  out.z = cz + (ez / len) * r
  return true
}
