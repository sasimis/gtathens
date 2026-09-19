// Weapon controller: firing, recoil/bloom, ammo, reload, weapon switching,
// hit tests (capsule hitboxes + headshots), fist melee.
//
// Fire model (the reason this file exists):
//   1. The shot ray ALWAYS starts at the CAMERA, along the reticle direction
//      (mouse NDC, or screen centre when no mouse has moved yet). The player's
//      own body is skipped in that cast: a third-person character is drawn
//      offset from the reticle, so a ray from the gun would miss whatever the
//      crosshair covers.
//   2. That camera ray yields the AIM POINT — what the crosshair is over.
//   3. The damage ray runs from the MUZZLE to the aim point: the tracer still
//      leaves the barrel, a wall you are hugging still stops the bullet, and the
//      point under the crosshair is what gets hit. The gun mesh is then turned
//      to LOOK AT the aim point (GunMount IK) so the barrel agrees with the shot.
//   4. Peds resolve through analytic capsule + head hitboxes (lib/hitbox.js)
//      instead of a proximity sphere, with a headshot multiplier.
//
// Every timed value (rate of fire, reload, recoil recovery, bloom) uses the REAL
// frame delta. The old code stepped a fixed 0.016 s per frame, so the rate of
// fire followed the framerate — an SMG fired ~2.4x too slow at 144 Hz and ~2x
// too fast in a throttled tab. That alone reads as "the guns feel bad".
import React, { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useKeyboardControls } from '@react-three/drei'
import { useRapier } from '@react-three/rapier'
import * as THREE from 'three'
import useGameStore, { Phase } from '../store/useGameStore'
import { WEAPONS, gunFX } from '../lib/weapons'
import { mouseAim } from '../lib/aim'
import {
  combat,
  combatReset,
  decayCombat,
  coneFor,
  noteShot,
  noteHit,
  noteKill,
  setFiring,
  ASSIST_CONE_DEG,
  ASSIST_RANGE,
  TOUCH_HITBOX_SCALE,
} from '../lib/combat'
import { pedRayHit, makeHit } from '../lib/hitbox'
import { BTN, getGamepad, padValue, padEdge } from '../lib/gamepad'
import { GunMount } from './Weapon'
import {
  fireTracer,
  muzzleFlash,
  impactFlash,
  IMPACT_CONCRETE,
  IMPACT_DUST,
  IMPACT_METAL,
  IMPACT_FLESH,
} from './BulletFx'
import { NPC_RECORDS } from './Npcs'
import { CAR_LIVE_POS, crash } from './Car'
import { audio } from '../lib/audio'

// --- module scratch (no allocation inside useFrame) -------------------------
const aimDir = new THREE.Vector3() // reticle direction (world, unit)
const aimPoint = new THREE.Vector3() // where the reticle ray lands
const muzzleVec = new THREE.Vector3() // barrel tip (world)
const shotDir = new THREE.Vector3() // muzzle -> target (unit)
const rightVec = new THREE.Vector3()
const upVec = new THREE.Vector3()
const tmpV = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

// Result of a world raycast (module scratch — reused by every cast).
const worldHit = { hit: false, toi: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, handle: -1 }
const pedOut = makeHit()
// Aim-assist input triple (a plain {x,y,z} the magnet can rewrite in place).
const aimAssistDir = { x: 0, y: 0, z: 0 }
// Camera->aim-point distance for the current frame + whether the magnet fired.
let aimReach = 0
let aimAssisted = false
// Context handed to the per-bullet resolver (mutated, never re-created).
const fireCtx = { world: null, rapier: null, bodyRef: null }

const AIM_MAX = 100 // the reticle ray reaches 100 m (the brief's number)
const PED_GRACE = 0.35 // metres past a wall hit that a ped may still be struck
const FLINCH_TIME = 0.22 // hit-reaction stagger length (Npcs.jsx consumes it)

const fireState = {
  wantFire: false,
  fireCooldown: 0,
  reloading: false,
  reloadT: 0,
  reloadDur: 1.6,
  kbWasDown: false,
  mouseDown: false,
  reloadEdge: false,
}

let reloadEl = null
const setReloadUI = (pct) => {
  if (!reloadEl || !reloadEl.isConnected) reloadEl = document.getElementById('gtathens-reload')
  if (!reloadEl) return
  const on = pct > 0
// --- QA telemetry (scripts/smoke.mjs reads this; written once per SHOT) -----
export const shotTrace = {
  shots: 0, impacts: 0, hits: 0, x: 0, y: 0, z: 0, toi: -1, muzzle: 0,
  ox: 0, oy: 0, oz: 0, px: 0, py: 0, pz: 0,
  head: 0, // 1 when the last damaging hit was a head hit
  kind: -1, // impact material of the last shot (BulletFx IMPACT_*)
  pellets: 0, // bullets fired by the last trigger pull
  bloom: 0, // cone half-angle used by the last shot (radians)
  assist: 0, // 1 when aim assist nudged the last shot
}
if (typeof window !== 'undefined') window.__gtathensShot = shotTrace

/** The player's own collider handle — keeps the camera ray off our own back. */
const selfColliderHandle = (bodyRef) => {
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
 * capsule — the ray is then resumed 0.35 m past it. That self-skip is why this
 * needs none of rapier's version-fragile exclude-collider query arguments.
 * Returns true when `worldHit.hit` was filled.
 */
const castWorld = (world, rapier, ox, oy, oz, dx, dy, dz, maxToi, skipHandle) => {
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
// Impact material: bullets into a car body spark, into the ground puff dust,
// everything else chips concrete (the brief's "different VFX per surface").
const METAL_R2 = 2.4 * 2.4
const nearCarXZ = (x, z) => {
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

const surfaceKind = (x, y, z) => {
  if (y < 0.35) return IMPACT_DUST
  if (nearCarXZ(x, z)) return IMPACT_METAL
  return IMPACT_CONCRETE
}

/**
 * Damage + reaction on a ped. Kinematic peds cannot take a real impulse, so the
 * "hit reaction" is a stagger Npcs.jsx consumes (flinchT/flinchX/flinchZ/
 * flinchSpeed) plus the weapon's headshot multiplier.
 */
const damagePed = (st, nr, kind, def, dirX, dirZ) => {
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

// Aim assist for sticks/touch: nudge the reticle toward the ped nearest to it
// within ASSIST_CONE_DEG, measured from the unassisted reticle. Rewrites `dir`
// ({x,y,z}) in place and returns true when it moved the shot.
const applyAimAssist = (dir, ox, oy, oz, maxRange) => {
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
  // Confidence ramps to 1 at the cone centre: a near miss snaps hard, an
  // edge-of-cone flick only nudges.
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
/** One hitscan bullet: muzzle -> (dx,dy,dz), resolves peds + world + FX. */
const fireBullet = (ctx, st, def, ox, oy, oz, dx, dy, dz, fxOnce, damageOnce) => {
  const { world, rapier } = ctx
  const range = def.range || 90
  // Wall along the bullet's path (self-skip in case a bad mount starts the ray
  // inside the shooter's own capsule — normally the muzzle is already outside).
  const hitSomething = castWorld(
    world, rapier, ox, oy, oz, dx, dy, dz, range, selfColliderHandle(ctx.bodyRef),
  )
  const wallT = hitSomething ? worldHit.toi : range

  // Ped hitboxes: the nearest ped this bullet's line actually pierces.
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
    // A body hugging cover may still be struck just past the wall, but a
    // building never lets a bullet through: only PED_GRACE metres are allowed.
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

  // One tracer per trigger pull (not per pellet) so a shotgun does not paint a
  // white cone across the street.
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
    // Clean miss: keep the previous impact point so the QA trail still shows
    // what the last round actually struck (toi/kind say "miss").
// Fists keep their own tuning (a punch hits harder than the legacy "fists"
// entry in the weapon table but uses the same schema).
const FISTS_DEF = { ...WEAPONS.fists, damage: 20, cooldown: 0.38, knockback: 1.6 }

// Per-trigger-pull scratch: a shotgun fires 8 pellets but we only want one
// tracer and one hitmarker tick.
const fxOnce = { tracer: false }
const damageOnce = { n: false }

const WeaponController = ({ bodyRef, modelRef, camYaw }) => {
  const { world, rapier } = useRapier()
  const { camera } = useThree()
  const [, getKeys] = useKeyboardControls()
  const prevKeys = useRef({})

  // ONE primitive per selector: zustand v5 has no shallow equality and an
  // object-returning selector re-renders forever (black screen — see AGENTS.md).
  const phase = useGameStore((s) => s.phase)
  const equipped = useGameStore((s) => s.equipped)
  const inventoryOpen = useGameStore((s) => s.inventoryOpen)
  const driving = useGameStore((s) => s.driving)
  const cycleWeapon = useGameStore((s) => s.cycleWeapon)
  const def = equipped && equipped !== 'fists' ? WEAPONS[equipped] : null

  // A freshly drawn gun must not inherit the previous gun's bloom / recoil /
  // aim point — resetting on every equip change also covers ground pickups.
  useEffect(() => {
    combatReset()
    gunFX.recoil = 0
  }, [equipped])

  // Mouse / pointer fire (LMB), gated on phase + inventory + driving.
  useEffect(() => {
    const down = (e) => {
      if (e.button !== 0) return
      if (phase !== Phase.PLAYING || inventoryOpen || driving !== null) return
      fireState.mouseDown = true
      fireState.wantFire = true
    }
    const up = () => {
      fireState.mouseDown = false
      if (!fireState.kbWasDown && !combat.touchFire) fireState.wantFire = false
    }
    window.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up)
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up)
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
    }
  }, [phase, inventoryOpen, driving])

  // QA seam for scripts/smoke.mjs: muzzle chain + gun-IK state. A stable
  // read-only object, like the rest of the debug hooks.
  useEffect(() => {
    window.__gtathensMuzzle = () => {
      const ok = gunFX.getMuzzle ? gunFX.getMuzzle(muzzleVec) : false
      return {
        ok: !!ok,
        x: +muzzleVec.x.toFixed(3),
        y: +muzzleVec.y.toFixed(3),
        z: +muzzleVec.z.toFixed(3),
        held: gunFX.held,
        aimOk: combat.aimOk,
        aim: [+combat.aimX.toFixed(2), +combat.aimY.toFixed(2), +combat.aimZ.toFixed(2)],
useFrame((state, delta) => {
    // Real time since the last frame (clamped): every timer below is scaled by
    // it, so rate of fire / reload / recoil recovery no longer follow the
    // framerate.
    const dt = Math.min(Math.max(delta, 0), 0.05)
    decayCombat(dt)

    const st = useGameStore.getState()
    // Hit-stop (the brief's "freeze 30 ms on a headshot kill"): bailing out
    // before reload / fire / aim freezes the gun pose exactly as it was, and
    // FollowCamera holds the camera with it.
    if (combat.hitstopT > 0) {
      setReloadUI(combat.reload01)
      return
    }

    setReloadUI(fireState.reloading ? fireState.reloadT / fireState.reloadDur : 0)
    if (!world || st.phase !== Phase.PLAYING) {
      if (st.phase !== Phase.PLAYING) {
        fireState.wantFire = false
        fireState.reloadEdge = false
        combat.aimOk = false
        combat.reloading = false
        combat.reload01 = 0
      }
      return
    }

    // --- Weapon-switch cooldown drain (seconds) ---
    if (st.weaponChangeLeft > 0) st.drainWeaponChange(dt)

    const eq = st.equipped
    const isFists = eq === 'fists'
    const wdef = isFists ? FISTS_DEF : WEAPONS[eq]
    if (!wdef) return
    const wrec = isFists
      ? { id: 'fists', mag: 99, reserve: 99 }
      : st.weapons.find((x) => x.id === eq) || null

    // --- keyboard ---
    const keys = getKeys()
    const kprev = prevKeys.current
    if (keys.cycleNext && !kprev.cycleNext) cycleWeapon(1)
    if (keys.cyclePrev && !kprev.cyclePrev) cycleWeapon(-1)
    if (keys.reload && !kprev.reload) fireState.reloadEdge = true
    prevKeys.current = keys

    const kbNow = !!keys.fire
    if (kbNow && !fireState.kbWasDown) {
      fireState.kbWasDown = true
      fireState.wantFire = true
    } else if (!kbNow) {
      fireState.kbWasDown = false
      if (!fireState.mouseDown && !combat.touchFire) fireState.wantFire = false
    }

    // --- gamepad RT (X as a digital fallback) ---
    const gp = getGamepad()
    if (gp) {
      combat.assist = true
      const rt = padValue(gp, BTN.RT) || (padEdge(gp, BTN.X) ? 1 : 0)
      if (rt > 0.2) fireState.wantFire = true
      else if (rt <= 0.15 && !fireState.kbWasDown && !fireState.mouseDown && !combat.touchFire) {
        fireState.wantFire = false
      }
      if (padEdge(gp, BTN.LB)) fireState.reloadEdge = true
    } else if (!combat.isTouch) {
      combat.assist = false
    }

    // --- touch trigger (the big on-screen button in ui/Crosshair.jsx) ---
    if (combat.touchFire) {
      combat.assist = true
      fireState.wantFire = true
    }

    // --- reload (per-weapon time; combat.reloading cancels sprint in Player) ---
    if (fireState.reloading) {
      fireState.reloadT += dt
      combat.reloading = true
      combat.reload01 = Math.min(1, fireState.reloadT / fireState.reloadDur)
      if (fireState.reloadT >= fireState.reloadDur) {
        fireState.reloading = false
        combat.reloading = false
        combat.reload01 = 0
        st.reloadWeapon()
      }
      return
    }
    combat.reloading = false
// --- reticle aim (every frame, guns only) --------------------------------
    // The ray starts at the CAMERA through the crosshair NDC. mouseAim is
    // written by ui/Crosshair.jsx; with no mouse yet (or headless) the NDC is
    // (0,0) = screen centre, i.e. plain camera-forward. The shooter's own
    // capsule is skipped, so you can never shoot your own back off.
    if (!isFists && gunFX.held) {
      aimDir.set(mouseAim.nx, mouseAim.ny, 0.5).unproject(camera).sub(camera.position)
      if (aimDir.lengthSq() < 1e-8) aimDir.set(0, 0, -1).applyQuaternion(camera.quaternion)
      aimDir.y = Math.max(-0.85, Math.min(0.85, aimDir.y))
      aimDir.normalize()
      const camX = camera.position.x
      const camY = camera.position.y
      const camZ = camera.position.z
      // Aim assist (stick / touch only) magnetises the reticle first.
      aimAssistDir.x = aimDir.x
      aimAssistDir.y = aimDir.y
      aimAssistDir.z = aimDir.z
      aimAssisted = applyAimAssist(aimAssistDir, camX, camY, camZ, ASSIST_RANGE)
      aimDir.set(aimAssistDir.x, aimAssistDir.y, aimAssistDir.z)
      // Reticle ray: origin = camera, distance capped by the weapon's range.
      const reticleMax = Math.min(AIM_MAX, wdef.range)
      let aimToi = reticleMax
      if (castWorld(
        world, rapier, camX, camY, camZ, aimDir.x, aimDir.y, aimDir.z,
        reticleMax, selfColliderHandle(bodyRef),
      )) {
        aimToi = Math.min(worldHit.toi, reticleMax)
      }
      aimPoint.set(camX + aimDir.x * aimToi, camY + aimDir.y * aimToi, camZ + aimDir.z * aimToi)
      aimReach = aimToi
      // Published for the gun IK (<GunMount> turns the barrel at this point),
      // the camera (shake/kick) and the QA seam. Numbers only, every frame.
      combat.aimX = aimPoint.x
      combat.aimY = aimPoint.y
      combat.aimZ = aimPoint.z
      combat.aimOk = true
    } else {
      combat.aimOk = false
      aimReach = 0
      aimAssisted = false
    }

    // --- fire / attack gating ---
    const want = fireState.wantFire
    setFiring(want && st.weaponChangeLeft <= 0)
    // While swapping weapons, suppress fire but keep the cooldown ticking down.
    if (st.weaponChangeLeft > 0) return
    if (!want || !wrec || wrec.mag < 0) {
      if (!want) fireState.fireCooldown = 0
      return
    }
    if (!isFists && wrec.mag <= 0) {
      if (wrec.reserve > 0) {
        fireState.reloading = true
        fireState.reloadT = 0
        fireState.reloadDur = Number.isFinite(wdef.reloadTime) ? wdef.reloadTime : 1.6
      }
      fireState.wantFire = false
      return
    }

    const cooldown = Number.isFinite(wdef.rpm) && wdef.rpm > 0 ? 60 / wdef.rpm : wdef.cooldown
    fireState.fireCooldown -= dt
    if (fireState.fireCooldown > 0) {
      if (!wdef.auto) fireState.wantFire = false
      return
    }
    fireState.fireCooldown = cooldown
// --- Fist attack (melee, no ray) ------------------------------------
    if (isFists) {
      window.__gtathensPunchT = 0.35 // tweens the arm swing in Protagonist
      audio.play('melee')
      fireState.wantFire = false
      combat.aimHold = 0.3 // keep the body squared up while swinging
      combat.shake = Math.max(combat.shake, wdef.shake || 0.06)
      shotTrace.shots += 1
      shotTrace.pellets = 0
      shotTrace.bloom = 0
      shotTrace.assist = 0
      shotTrace.head = 0
      const pb = bodyRef && bodyRef.current
      let pt = null
      if (pb && typeof pb.translation === 'function') {
        try { pt = pb.translation() } catch (e) { pt = null }
      }
      if (pt) {
        let best = -1
        let bestD = 3.2 // ~1.8 m reach (the old proximity swing)
        for (let k = 0; k < NPC_RECORDS.length; k += 1) {
          const nr = NPC_RECORDS[k]
          if (!nr || nr.dead || !nr.rb || typeof nr.rb.translation !== 'function') continue
          let bt = null
          try { bt = nr.rb.translation() } catch (e) { continue }
          if (!bt) continue
          const dx = bt.x - pt.x
          const dy = bt.y - pt.y
          const dz = bt.z - pt.z
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < bestD) {
            bestD = d2
            best = k
          }
        }
        if (best >= 0) {
          const nr = NPC_RECORDS[best]
          let bt = null
          try { bt = nr.rb.translation() } catch (e) { bt = null }
          if (bt) {
            const dx = bt.x - pt.x
            const dz = bt.z - pt.z
            const l = Math.hypot(dx, dz) || 1
            audio.play('hit')
            shotTrace.hits += 1
            shotTrace.impacts += 1
            damagePed(st, nr, 1, wdef, dx / l, dz / l)
          }
        }
        shotTrace.px = pt.x
        shotTrace.py = pt.y
        shotTrace.pz = pt.z
      }
      if (modelRef && modelRef.current) modelRef.current.rotation.x = 0
      return
    }

    // --- Gun: fire `pellets` hitscan bullets from the muzzle ---------------
    // noteShot owns the "feel" bookkeeping: bloom growth (which the reticle
    // draws), the recoil-pattern camera kick and the shake.
    noteShot(wdef, now)
    combat.spread = coneFor(wdef)
    const cone = combat.spread
    const span = (wdef.spreadMax || 0) - (wdef.spread || 0)
    combat.bloom01 = span > 0 ? Math.min(1, combat.bloom / span) : combat.bloom > 0 ? 1 : 0
    gunFX.recoil = 1
    gunFX.kick = Number.isFinite(wdef.recoilKick) ? wdef.recoilKick : 0.04

    // Barrel origin (falls back to the camera if the mount is not ready yet).
    const muzzleOk = !!(gunFX.getMuzzle && gunFX.getMuzzle(muzzleVec))
    const ox = muzzleOk ? muzzleVec.x : camera.position.x
    const oy = muzzleOk ? muzzleVec.y : camera.position.y
    const oz = muzzleOk ? muzzleVec.z : camera.position.z

    // Perpendicular basis around the reticle: pellets scatter on a disc around
    // the aim point, scaled by the distance so the pattern widens with range
    // (what a cone does, without a per-pellet direction jitter).
    rightVec.crossVectors(aimDir, UP)
    if (rightVec.lengthSq() < 1e-6) rightVec.set(1, 0, 0)
    rightVec.normalize()
    upVec.crossVectors(rightVec, aimDir).normalize()
    const spreadR = Math.tan(cone) * Math.max(2, aimReach)
    const pellets = Math.max(1, wdef.pellets || 1)

    fxOnce.tracer = false
    damageOnce.n = false
    shotTrace.head = 0
    fireCtx.world = world
    fireCtx.rapier = rapier
    fireCtx.bodyRef = bodyRef
    for (let p = 0; p < pellets; p += 1) {
      let tx = aimPoint.x
      let ty = aimPoint.y
      let tz = aimPoint.z
      if (spreadR > 0.0005) {
        const th = Math.random() * Math.PI * 2
        const rr = Math.sqrt(Math.random()) * spreadR
        const rx = Math.cos(th) * rr
        const ry = Math.sin(th) * rr
        tx += rightVec.x * rx + upVec.x * ry
        ty += rightVec.y * rx + upVec.y * ry
        tz += rightVec.z * rx + upVec.z * ry
      }
      shotDir.set(tx - ox, ty - oy, tz - oz)
      const l = shotDir.length() || 1
      shotDir.multiplyScalar(1 / l)
      fireBullet(fireCtx, st, wdef, ox, oy, oz, shotDir.x, shotDir.y, shotDir.z, fxOnce, damageOnce)
      fxOnce.tracer = true // only the first pellet draws a tracer
    }

    muzzleFlash(ox, oy, oz)
    audio.play('shoot')
    // The brief's hitmarker tick: an audible confirm on flesh.
    if (damageOnce.n) audio.play('hit')

    // Telemetry (field names the smoke test depends on — keep them stable).
    shotTrace.shots += 1
    shotTrace.muzzle = muzzleOk ? 1 : 0
    shotTrace.ox = ox
    shotTrace.oy = oy
    shotTrace.oz = oz
    shotTrace.pellets = pellets
    shotTrace.bloom = cone
    shotTrace.assist = aimAssisted ? 1 : 0
    const pb2 = bodyRef && bodyRef.current
    if (pb2 && typeof pb2.translation === 'function') {
      try {
        const t = pb2.translation()
        shotTrace.px = t.x
        shotTrace.py = t.y
        shotTrace.pz = t.z
      } catch (e) { /* noop */ }
    }

    // Whole-body kick: the model leans back with the recoil (Protagonist adds
    // the additive arm layer; the camera gets the patterned pitch kick).
    if (modelRef && modelRef.current) {
      modelRef.current.rotation.x = -combat.recoil * 0.045
    }
    if (!wdef.auto) fireState.wantFire = false
  })

  return equipped && equipped !== 'fists' && def ? <GunMount weaponId={equipped} /> : null
}

export default WeaponController
    if (!isFists) st.spendMag()
    const now = performance.now()
    combat.reload01 = 0
    if (!isFists && fireState.reloadEdge && wrec && wrec.mag < wdef.mag && wrec.reserve > 0) {
      fireState.reloading = true
      fireState.reloadT = 0
      fireState.reloadDur = Number.isFinite(wdef.reloadTime) ? wdef.reloadTime : 1.6
      combat.reloading = true
      audio.play('reload')
    }
    fireState.reloadEdge = false
        bloom01: +combat.bloom01.toFixed(3),
        recoil: +combat.recoil.toFixed(2),
      }
    }
    return () => { delete window.__gtathensMuzzle }
  }, [])
    shotTrace.toi = -1
    shotTrace.kind = -1
  }
}
  dir.z /= l
  return true
}
  return false
}
  if (reloadEl.hidden === on) reloadEl.hidden = !on
  if (!on) return
  const fill = reloadEl.firstElementChild
  if (fill) fill.style.width = `${Math.round(Math.min(1, pct) * 100)}%`
}