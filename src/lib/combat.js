// Shared "gun feel" state — ONE module-level object mutated in place, exactly
// like lib/aim.js and lib/weapons.js#gunFX. Nothing here allocates on the hot
// path (the house rule for anything a useFrame touches).
//
// Writers / readers:
//   WeaponController.jsx  — writes bloom, recoil, shake, hitstop, aimHold,
//                           the aim point, the reload flag and the hit marker
//   Weapon.jsx (GunMount) — reads recoil + the aim point (gun IK)
//   FollowCamera.jsx      — reads recoilPitch + shake + hitstopT (camera kick)
//   Player.jsx            — reads hitstopT (input freeze) + aimHold (face the
//                           camera while shooting) + reloading (cancels sprint)
//   ui/Crosshair.jsx      — reads bloom01 (reticle gap) + the hit markers
//
// Everything is in world units / radians / seconds so the numbers below can be
// reasoned about directly against a weapon definition in lib/weapons.js.

export const combat = {
  // --- spread / bloom -------------------------------------------------------
  bloom: 0, // extra cone half-angle accumulated by the current burst (radians)
  bloom01: 0, // bloom normalized to the weapon's max (0..1) — drives the UI
  spread: 0, // the cone actually used by the last shot (radians)
  shots: 0, // shots in the current burst (reset after a short gap)
  lastShotAt: 0,

  // --- recoil ---------------------------------------------------------------
  recoil: 0, // 0..1 gun + arm kick (consumed by GunMount / Protagonist)
  recoilPitch: 0, // radians of camera muzzle-climb still to apply
  recoilYaw: 0, // radians of horizontal drift still to apply

  // --- juice ----------------------------------------------------------------
  shake: 0, // 0..1 camera shake amplitude, decays every frame
  hitstopT: 0, // seconds of hit-stop left (headshot kills freeze ~35 ms)
  aimHold: 0, // seconds the character must keep facing the camera (aim mode)

  // --- weapon state mirrored for other systems ------------------------------
  reloading: false, // true while a reload plays (cancels sprint)
  reload01: 0, // reload progress 0..1 (the DOM bar reads this)
  firing: false, // true while the trigger is held

  // --- hit feedback ---------------------------------------------------------
  hitAt: 0, // performance.now() of the last damaging hit
  hitKind: 0, // 0 = none, 1 = body, 2 = head
  hits: 0, // total damaging hits (monotonic — the UI polls deltas)
  headshots: 0,
  kills: 0,

  // --- gun IK target (world space) ------------------------------------------
  aimX: 0,
  aimY: 0,
  aimZ: 0,
  aimOk: false,

  // --- touch / gamepad aim assist -------------------------------------------
  isTouch: false, // coarse pointer detected once on module load
  assist: false, // pad or touch present => aim magnet + bigger hitboxes
  touchFire: false, // big on-screen trigger button
  touchAim: false, // held "aim" button (slows the player, tightens spread)
}

// Aim-assist tuning (the stick/touch "magnet" from the design brief).
export const ASSIST_CONE_DEG = 10 // smallest angle magnetised toward a ped
export const ASSIST_RANGE = 70 // metres
export const TOUCH_HITBOX_SCALE = 1.3 // +30% capsule/head radius on touch

// Resolve the input class once. A touch device also gets the bigger hitboxes,
// which is the cheap way to make thumb-aiming land without changing stats.
if (typeof window !== 'undefined') {
  try {
    const coarse =
      (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) ||
      (navigator.maxTouchPoints || 0) > 0
    combat.isTouch = !!coarse
    combat.assist = !!coarse
  } catch (e) { /* keep defaults */ }
}

// Packed return value for the recoil-pattern lookup (module scope: no alloc).
const patternOut = { x: 0, y: 1 }

/**
 * Recoil-pattern sample for shot `n` of a burst: `y` scales the vertical kick,
 * `x` the horizontal drift. Weapons without a pattern kick straight up.
 * Mirrors the `recoilPattern: [{x, y}, ...]` shape from the design brief.
 */
export const kickFor = (def, n) => {
  const pat = def && def.recoilPattern
  if (!pat || pat.length === 0) {
    patternOut.x = 0
    patternOut.y = 1
    return patternOut
  }
  const p = pat[n < pat.length ? n : pat.length - 1]
  patternOut.x = p.x
  patternOut.y = p.y
  return patternOut
}

/**
 * Called once per fired round. Grows the bloom, spikes the gun/arm kick and
 * queues the camera muzzle climb. `now` is performance.now().
 */
export const noteShot = (def, now) => {
  // A burst is "held fire" — a 0.35 s gap means the reticle has settled.
  if (now - combat.lastShotAt > 350) {
    combat.shots = 0
    combat.bloom = 0
  }
  combat.lastShotAt = now
  const gain = def && Number.isFinite(def.spreadGain) ? def.spreadGain : 0
  const max = def && Number.isFinite(def.spreadMax) ? def.spreadMax : 0
  const base = def && Number.isFinite(def.spread) ? def.spread : 0
  combat.bloom = Math.min(Math.max(0, max - base), combat.bloom + gain)
  const k = kickFor(def, combat.shots)
  const recoil = def && Number.isFinite(def.recoil) ? def.recoil : 0.012
  combat.recoil = 1
  combat.recoilPitch += recoil * k.y
  combat.recoilYaw += recoil * k.x
  combat.shake = Math.max(combat.shake, def && Number.isFinite(def.shake) ? def.shake : 0.1)
  combat.shots += 1
}

/** Cone half-angle for the shot about to be fired (base + unsettled bloom). */
export const coneFor = (def) => {
  const base = def && Number.isFinite(def.spread) ? def.spread : 0
  const max = def && Number.isFinite(def.spreadMax) ? def.spreadMax : base
  return Math.min(max, base + combat.bloom)
}

/** Body hit (1) or head hit (2) — sets the hit marker + counters. */
export const noteHit = (kind, now) => {
  combat.hitAt = now
  combat.hitKind = kind
  combat.hits += 1
  if (kind === 2) combat.headshots += 1
  combat.aimHold = Math.max(combat.aimHold, 0.4)
}

/** Kill: hit-stop so the last round lands with weight (headshots hit harder). */
export const noteKill = (kind) => {
  combat.kills += 1
  combat.hitstopT = Math.max(combat.hitstopT, kind === 2 ? 0.06 : 0.03)
  combat.shake = Math.max(combat.shake, kind === 2 ? 0.5 : 0.3)
}

/** Called when the trigger goes down / releases (drives `firing`). */
export const setFiring = (v) => { combat.firing = !!v }

/** Weapon switch / unmount: clear anything that could leak into the next gun. */
export const combatReset = () => {
  combat.bloom = 0
  combat.bloom01 = 0
  combat.spread = 0
  combat.shots = 0
  combat.recoil = 0
  combat.recoilPitch = 0
  combat.recoilYaw = 0
  combat.shake = 0
  combat.hitstopT = 0
  combat.aimHold = 0
  combat.reloading = false
  combat.reload01 = 0
  combat.firing = false
  combat.aimOk = false
}

const BLOOM_SETTLE = 2.2 // radians of cone recovered per second
const KICK_RETURN = 9 // camera kick decay (rad per second of a rad)
const SHAKE_DECAY = 3.6

/** Per-frame decay for every effect. `dt` is clamped by the caller. */
export const decayCombat = (dt) => {
  if (combat.bloom > 0) combat.bloom = Math.max(0, combat.bloom - BLOOM_SETTLE * dt)
  if (combat.recoil > 0) combat.recoil = Math.max(0, combat.recoil - dt * 7)
  // Camera kick returns to zero — exponential so it never overshoots.
  if (combat.recoilPitch !== 0) {
    combat.recoilPitch *= Math.exp(-KICK_RETURN * dt)
    if (Math.abs(combat.recoilPitch) < 1e-5) combat.recoilPitch = 0
  }
  if (combat.recoilYaw !== 0) {
    combat.recoilYaw *= Math.exp(-KICK_RETURN * dt)
    if (Math.abs(combat.recoilYaw) < 1e-5) combat.recoilYaw = 0
  }
  if (combat.shake > 0) combat.shake = Math.max(0, combat.shake - SHAKE_DECAY * dt)
  if (combat.hitstopT > 0) combat.hitstopT = Math.max(0, combat.hitstopT - dt)
  if (combat.aimHold > 0) combat.aimHold = Math.max(0, combat.aimHold - dt)
}

// QA seam (scripts/smoke.mjs / console): stable object, read-only for callers.
if (typeof window !== 'undefined') window.__gtathensCombat = combat

export default combat