// car-modules/carVisuals.js
// Shared visual-animation helpers for cars: wheel pose estimation, detachable
// trim thresholds, and a zero-alloc debris event queue.
//
// Why this file exists: the KayKit GLBs are a SINGLE merged mesh (1 mesh, 1
// material — verified from the GLB JSON chunk), so there are no sub-meshes to
// detach or wheels to spin. All "parts" below are PROCEDURAL overlays sized
// from the car's HALF extents: spinning wheel discs, breakaway bumpers and a
// pooled debris/smoke system. Nothing here touches physics or React state.

export const WHEEL_R_BY_CLASS = { sports: 0.33, muscle: 0.35, sedan: 0.34, suv: 0.40 }

// Measured wheel-arch centers (world meters, nose = +Z), extracted from the
// GLB vertex clouds: rotate raw POSITIONs by the showroom node quaternion,
// take the low band (bottom 30% of height = wheels + skirts), split at the
// Z midpoint, and average the wide-track (|x| > median) verts per half.
// Verified values per model (x = half-track, y = center height, zF/zR):
//   sedan/sports: x .90 y .28 zF +1.25 zR -1.51
//   suv:          x 1.04 y .36 zF +1.69 zR -1.62
const WHEEL_POSE = {
  sedan: { x: 0.90, y: 0.30, zF: 1.25, zR: -1.51 },
  sports: { x: 0.90, y: 0.30, zF: 1.24, zR: -1.51 },
  muscle: { x: 0.81, y: 0.28, zF: 1.20, zR: -1.45 },
  suv: { x: 1.04, y: 0.37, zF: 1.69, zR: -1.62 },
}

const wheelClass = (carId = '') => {
  const cls = (carId || '').toLowerCase()
  if (cls.includes('suv')) return 'suv'
  if (cls.includes('sports')) return 'sports'
  if (cls.includes('muscle')) return 'muscle'
  return 'sedan'
}

// Wheel centers in model space (nose = +Z), snapped to the measured arches
// above. The overlay discs (r - 0.06) sit just INSIDE the baked fenders so
// only the dark tire ring + hub show — never a doubled wheel.
export const estimateWheels = (half, carId = '') => {
  const key = wheelClass(carId)
  const pose = WHEEL_POSE[key]
  const r = WHEEL_R_BY_CLASS[key]
  return { r: r - 0.06, positions: [
    { x: -pose.x, y: pose.y, z: pose.zF, front: true, side: -1 },
    { x: pose.x, y: pose.y, z: pose.zF, front: true, side: 1 },
    { x: -pose.x, y: pose.y, z: pose.zR, front: false, side: -1 },
    { x: pose.x, y: pose.y, z: pose.zR, front: false, side: 1 },
  ] }
}

// Damage thresholds (0..1) where procedural trim breaks off. Bumpers go
// first, then mirrors, then the exhaust. Thresholds are ordered so a single
// `damage` number drives deterministic visibility without extra state.
export const PART_LOSS = [
  { part: 'bumperRear', at: 0.25 },
  { part: 'bumperFront', at: 0.4 },
  { part: 'mirrorL', at: 0.55 },
  { part: 'mirrorR', at: 0.62 },
  { part: 'exhaust', at: 0.7 },
]

export const lostParts = (damage = 0) => {
  const d = Math.max(0, Math.min(1, damage))
  const out = []
  for (let i = 0; i < PART_LOSS.length; i += 1) {
    if (d >= PART_LOSS[i].at) out.push(PART_LOSS[i].part)
  }
  return out
}

export const hasLostPart = (damage = 0, part = '') => {
  for (let i = 0; i < PART_LOSS.length; i += 1) {
    if (PART_LOSS[i].part === part) return damage >= PART_LOSS[i].at
  }
  return false
}

// ---------------------------------------------------------------------------
// Debris event queue — crashManager pushes, <CarDebrisPool> drains.
// Fixed ring buffer (64 slots), zero allocation after init. Each event is a
// flat object reused in place: { x,y,z, vx,vy,vz, kind, n }.
// kind: 0 = bumper chunk, 1 = glass/mirror spark, 2 = smoke puff,
//       3 = EXPLOSION (CarDebrisPool spawns the fireball + dark-smoke burst,
//           flash light and the lingering wreck fire from this one event).
export const DEBRIS_CHUNK = 0
export const DEBRIS_SPARK = 1
export const DEBRIS_SMOKE = 2
export const DEBRIS_EXPLOSION = 3
// ---------------------------------------------------------------------------
const DEBRIS_CAP = 64
export const debrisQueue = {
  buf: Array.from({ length: DEBRIS_CAP }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, kind: 0, n: 0 })),
  head: 0,
  tail: 0,
  count: 0,
}

export const pushDebris = (x, y, z, vx, vy, vz, kind = 0, n = 6) => {
  const q = debrisQueue
  const s = q.buf[q.tail]
  s.x = x; s.y = y; s.z = z
  s.vx = vx; s.vy = vy; s.vz = vz
  s.kind = kind; s.n = n
  q.tail = (q.tail + 1) % DEBRIS_CAP
  if (q.count < DEBRIS_CAP) q.count += 1
  else q.head = (q.head + 1) % DEBRIS_CAP // overwrite oldest, never grow
}

export const drainDebris = (fn) => {
  const q = debrisQueue
  while (q.count > 0) {
    const s = q.buf[q.head]
    q.head = (q.head + 1) % DEBRIS_CAP
    q.count -= 1
    try { fn(s.x, s.y, s.z, s.vx, s.vy, s.vz, s.kind, s.n) } catch {}
  }
}

// QA seam: how many debris events are pending (smoke test can assert > 0
// after a ram without reading React state).
// ---------------------------------------------------------------------------
// Per-spot visual animation state — written by CarDriver (driven car) every
// frame, read by CarAnim (every car) in the SAME frame. Stable objects,
// mutated in place, never re-rendered: { speed, steer, nitro, crashAt }.
// Index = parking spot; AI cars use `ai<i>` keys (Npcs writes them too).
// ---------------------------------------------------------------------------
export const animState = { spots: [], ai: [] }

export const setAnimSpot = (i, speed, steer, nitro = false, brake = false) => {
  if (i == null || i < 0) return
  let s = animState.spots[i]
  if (!s) { s = { speed: 0, steer: 0, nitro: false, brake: false, crashAt: 0 }; animState.spots[i] = s }
  s.speed = speed; s.steer = steer; s.nitro = !!nitro; s.brake = !!brake
}

// AI cars: same visual state, keyed `ai<i>` (Npcs.jsx AiCar writes it).
export const setAnimAi = (i, speed, steer, brake = false) => {
  if (i == null || i < 0) return
  let s = animState.ai[i]
  if (!s) { s = { speed: 0, steer: 0, nitro: false, brake: false, crashAt: 0 }; animState.ai[i] = s }
  s.speed = speed; s.steer = steer; s.brake = !!brake
}

export const getAnimAi = (i) => animState.ai[i] ?? null

export const getAnimSpot = (i) => animState.spots[i] ?? null

export const markCrashAnim = (i) => {
  const s = animState.spots[i]
  if (s) { try { s.crashAt = performance.now() } catch { s.crashAt = 1 } }
}

if (typeof window !== 'undefined') {
  window.__gtathensDebris = { pending: () => debrisQueue.count }
  window.__gtathensCarAnim = animState
}
