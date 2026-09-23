// Compatibility barrel — the car system now lives in ./car-modules/:
//   constants.js       — IDs, HALF sizes, collision groups, crash/drive tuning
//   utils/polygon.js   — pointInPolygon + polyBBox (bbox pre-filter)
//   utils/misc.js      — normalizeId, hash01, roadHeading
//   crashManager.js    — ONE CrashManager singleton owns livePos, damage,
//                        loose, bodies, AI-traffic live state, isOnAsphalt
//   CarModel.jsx       — memoized GLB model (re-centered at load), per-instance damage tint
//   Car.jsx            — fixed body + imperative fixed<->dynamic toggle
//   useParkingSpots.js — deterministic layout, AbortController, bbox cull
//   CarDriver.jsx      — keys in useRef, exitCar useCallback, LooseSettler
//   ParkedCars.jsx     — useMemo refs, lazy preload of used models only
//
// This file re-exports the EXACT names the rest of the game imports from
// './Car' (App, Player, Pickups, Npcs, smoke test), so no caller changes.
// New code should import from './car-modules' (or the specific module file).
import useGameStore from '../store/useGameStore'
import { crash as crashForQA, spotsCache as spotsForQA, isOnAsphalt } from './car-modules/crashManager.js'

export {
  PARK_COUNT,
  PARK_RADIUS,
  CAR_IDS,
  HALF,
  LONG_IDS,
  GROUP_GROUND,
  GROUP_PLAYER,
  GROUP_CAR,
  GROUP_BUILDING,
  FILTER_ALL,
  CAR_COLLISION_GROUPS,
  PLAYER_COLLISION_GROUPS,
  CAR_MAX_SPEED,
  CAR_REVERSE_MAX,
  CAR_TURN_RATE,
} from './car-modules/constants.js'
export {
  crash,
  CAR_LIVE_POS,
  CAR_DAMAGE,
  spotsCache,
  getCarBody,
  AI_CAR_BODIES,
  AI_CAR_LIVE,
  AI_CAR_DAMAGE,
  isAiCarOccupied,
  setAiCarOccupied,
  aiDamage,
  addAiDamage,
  isOnAsphalt,
  addDamage,
  knockLoose,
  crashHitFromPayload,
  // RigidBodyType is an ENUM: always call setRigidBodyType (numeric) rather
  // than rb.setBodyType('fixed'), which coerces to 0 = Dynamic. See the note
  // in crashManager.js.
  setRigidBodyType,
  RB_DYNAMIC,
  RB_FIXED,
  RB_KINEMATIC_POS,
  RB_KINEMATIC_VEL,
} from './car-modules/crashManager.js'
export { crash as crashManager } from './car-modules/crashManager.js'
// setAiLive/getAiLive are METHODS on the crash singleton, not module exports —
// re-export thin wrappers (AudioSystem + Npcs import them from this barrel).
export const setAiLive = (i, x, z) => crashForQA.setAiLive(i, x, z)
export const getAiLive = (i) => crashForQA.getAiLive(i)
export { CarModel } from './car-modules/CarModel.jsx'
export { CarAnim } from './car-modules/CarAnim.jsx'
export { CarDebrisPool } from './car-modules/CarDebrisPool.jsx'
export { Car, CarByColor, Car as default } from './car-modules/Car.jsx'
export { useParkingSpots } from './car-modules/useParkingSpots.js'
export { CarDriver, LooseSettler } from './car-modules/CarDriver.jsx'
export { ParkedCars } from './car-modules/ParkedCars.jsx'

// Headless QA seam (scripts/smoke.mjs): fallback probe so the hook exists even
// before <ParkedCars> mounts. The LIVE hook (real spot state + cleanup) is
// installed by <ParkedCars> on mount and always wins while the world is up —
// single writer at a time.
const carsQA = {
  count: () => (spotsForQA.value || []).length,
  loose: () => crashForQA.loose.size,
  looseIdx: () => Array.from(crashForQA.loose),
  damage: (i) => crashForQA.damage[i] ?? 0,
  pos: (i) => {
    const rb = crashForQA.bodies[i]
    if (!rb || typeof rb.translation !== 'function') return null
    const t = rb.translation()
    return { x: t.x, y: t.y, z: t.z }
  },
  spot: (i) => {
    const s = (spotsForQA.value || [])[i]
    if (!s) return null
    const lp = crashForQA.livePos[i]
    return { id: s.id, x: lp ? lp.x : s.position[0], z: lp ? lp.z : s.position[2], rot: s.rotation }
  },
  btype: (i) => {
    const rb = crashForQA.bodies[i]
    if (!rb || typeof rb.bodyType !== 'function') return null
    try {
      return rb.bodyType()
    } catch (e) {
      return null
    }
  },
  roadSegs: () => (typeof window !== 'undefined' ? (window.__gtathensRoadCache?.segs?.length ?? 0) : 0),
  asphalt: (x, z) => isOnAsphalt(x, z),
  ram: (i) => {
    const spots = spotsForQA.value || []
    if (!spots.length) return null
    const j = ((i % spots.length) + spots.length) % spots.length
    const driving = useGameStore.getState().driving
    const mine = driving != null ? crashForQA.bodies[driving] : null
    const target = carsQA.spot(j)
    if (!mine || !target) return null
    const hx = Math.sin(target.rot)
    const hz = Math.cos(target.rot)
    const t = mine.translation()
    mine.setTranslation({ x: target.x - hx * 6.5, y: t.y, z: target.z - hz * 6.5 }, true)
    mine.setLinvel({ x: 0, y: 0, z: 0 }, true)
    mine.setAngvel({ x: 0, y: 0, z: 0 }, true)
    const c = Math.cos(target.rot / 2)
    const s = Math.sin(target.rot / 2)
    mine.setRotation({ x: 0, y: s, z: 0, w: c }, true)
    return { target: j, x: target.x - hx * 6.5, z: target.z - hz * 6.5 }
  },
}
if (typeof window !== 'undefined') window.__gtathensCars = carsQA
