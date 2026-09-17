// Weapon controller: firing, recoil, ammo, reload, weapon switching, hit tests.
//
// Keyboard: Q/E cycle weapons, R reload, X fire. Gamepad: RB cycle, RT shoot.
// Firing: ray from the camera (or from the gun muzzle when a GunMount is
// installed) with per-shot spread, up to `range` m. Hits resolve against the
// rapier world (castRay) so walls/buildings stop bullets. NPCs are hit-tested
// by distance to the impact point (cheap for a handful of peds).
import React, { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useKeyboardControls } from '@react-three/drei'
import { useRapier } from '@react-three/rapier'
import * as THREE from 'three'
import useGameStore, { Phase } from '../store/useGameStore'
import { WEAPONS, gunFX } from '../lib/weapons'
import { BTN, getGamepad, padValue, padEdge } from '../lib/gamepad'
import { GunMount } from './Weapon'
import { fireTracer, muzzleFlash, impactFlash } from './BulletFx'
import { NPC_RECORDS } from './Npcs'
import { audio } from '../lib/audio'

// Scratch vectors reused across shots (no per-frame allocation in the hot path).
const aimVec = new THREE.Vector3()
const originScratch = new THREE.Vector3()
const mpScratch = new THREE.Vector3()
const endPt = new THREE.Vector3()
const jit = new THREE.Vector3()

// ---- shared weapon-fire state (module-level, mutated in place) --------
const fireState = {
  wantFire: false,
  fireCooldown: 0,
  reloading: false,
  reloadT: 0,
  // Duration of the reload in progress (melee swings are much faster than a
  // magazine swap). Kept here so BOTH the completion test and the DOM reload
  // bar can derive progress from one source.
  reloadDur: 1.6,
  kbWasDown: false,
  mouseDown: false,
  reloadEdge: false,
}

// The reload bar lives in the DOM overlay (`ui/Inventory.jsx`), NOT in this
// component's JSX: WeaponController renders INSIDE <Canvas>, where a host
// element like <div> is not a THREE object — R3F throws
// "Div is not part of the THREE namespace!" and the whole scene unmounts.
// So the bar element is rendered by the DOM overlay (fixed id) and driven
// here imperatively, the same way DebugOverlay paints `#gtathens-debug`.
// Writes happen only while a reload is actually running (plus one write when
// it ends), i.e. a handful of frames per magazine — never steady-state.
let reloadEl = null
const setReloadUI = (pct) => {
  // Re-look-up after a remount (the overlay is unmounted in menu/pause, which
  // would otherwise leave this pointing at a detached node forever).
  if (!reloadEl || !reloadEl.isConnected) reloadEl = document.getElementById('gtathens-reload')
  if (!reloadEl) return // overlay not mounted (menu/pause)
  const on = pct > 0
  if (reloadEl.hidden === on) reloadEl.hidden = !on
  if (!on) return
  const fill = reloadEl.firstElementChild
  if (fill) fill.style.width = `${Math.round(Math.min(1, pct) * 100)}%`
}

// QA seam (scripts/smoke.mjs): last-shot telemetry — how many shots actually
// fired, where the ray impacted, and how many damaged a ped. Written once per
// SHOT (a rare event, ~5/s while holding the trigger), never per frame, so it
// stays allocation-free in steady state.
export const shotTrace = { shots: 0, impacts: 0, hits: 0, x: 0, y: 0, z: 0, toi: -1, muzzle: 0, ox: 0, oy: 0, oz: 0, px: 0, py: 0, pz: 0 }
if (typeof window !== 'undefined') window.__gtathensShot = shotTrace

const WeaponController = ({ bodyRef, modelRef, camYaw }) => {
  const { world, rapier } = useRapier()
  const { camera } = useThree()
  const [, getKeys] = useKeyboardControls()
  // Last frame's key snapshot, for rising-edge detection. Polled in useFrame
  // (NOT an effect): drei's useKeyboardControls returns [subscribe, getKeys],
  // and the subscribe function is stable, so an effect keyed on it would never
  // re-run — `keys.fire` was always undefined and X/Q/E/R did nothing. Polling
  // getKeys() each frame is the same pattern PlayerBody/Protagonist use.
  const prevKeys = useRef({})

  // One primitive selector per value. An OBJECT-returning selector
  // (`useGameStore((s) => ({ phase: s.phase, ... }))`) hands React a fresh
  // snapshot object on every call, and zustand v5 has no built-in shallow
  // equality — useSyncExternalStore then re-renders in a loop:
  // "Maximum update depth exceeded" -> the error boundary unmounts <Canvas>
  // and the game goes black the instant PLAY mounts the player.
  // (`weapons` / `reloadWeapon` are not read here at all: the hot path pulls
  // them from getState() inside useFrame, so they are not subscribed.)
  const phase = useGameStore((s) => s.phase)
  const equipped = useGameStore((s) => s.equipped)
  const inventoryOpen = useGameStore((s) => s.inventoryOpen)
  const driving = useGameStore((s) => s.driving)
  const cycleWeapon = useGameStore((s) => s.cycleWeapon)
  const def = equipped && equipped !== 'fists' ? WEAPONS[equipped] : null

  // Mouse / pointer fire (LMB), gated on phase + inventory + driving.
  useEffect(() => {
    const down = (e) => {
      if (e.button !== 0) return
      if (phase !== Phase.PLAYING || inventoryOpen || driving !== null) return
      if (!def) return
      fireState.mouseDown = true
      fireState.wantFire = true
    }
    const up = () => {
      fireState.mouseDown = false
      if (!fireState.kbWasDown) fireState.wantFire = false
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
  }, [phase, inventoryOpen, driving, def])

  useFrame(() => {
    // Fresh per-frame reads: the store mutates on every fire/reload, and the
    // DOM reload bar needs live progress (see setReloadUI). Runs before the
    // phase guard so Pausing mid-reload also hides the bar.
    const st = useGameStore.getState()
    setReloadUI(fireState.reloading ? fireState.reloadT / fireState.reloadDur : 0)
    if (!world || st.phase !== Phase.PLAYING) {
      if (st.phase !== Phase.PLAYING) { fireState.wantFire = false; fireState.reloadEdge = false }
      return
    }

    const eq = st.equipped
    const wdef = eq && eq !== 'fists' ? WEAPONS[eq] : null
    if (!wdef) return
    const wrec = st.weapons.find((x) => x.id === eq) || null

    // --- keyboard (polled every frame: drei's getKeys(), see prevKeys note) ---
    // Weapon cycle Q/E + reload R as rising edges, then the X fire edge.
    const keys = getKeys()
    const kprev = prevKeys.current
    if (keys.cycleNext && !kprev.cycleNext) cycleWeapon(1)
    if (keys.cyclePrev && !kprev.cyclePrev) cycleWeapon(-1)
    if (keys.reload && !kprev.reload) fireState.reloadEdge = true
    prevKeys.current = keys
    // Held X keeps an auto weapon firing (useFrame only clears wantFire for
    // semi-auto); a fresh press re-arms a semi-auto after a shot.
    const kbNow = !!keys.fire
    if (kbNow && !fireState.kbWasDown) {
      fireState.kbWasDown = true
      fireState.wantFire = true
    } else if (!kbNow) {
      fireState.kbWasDown = false
      if (!fireState.mouseDown) fireState.wantFire = false
    }

    // --- gamepad RT (analog fire) ---
    const gp = getGamepad()
    if (gp && !wdef.melee) {
      const rt = padValue(gp, BTN.RT)
      if (rt > 0.2) fireState.wantFire = true
      else if (rt <= 0.15 && !fireState.kbWasDown && !fireState.mouseDown) {
        fireState.wantFire = false
      }
    }
    // gamepad LB -> reload edge
    if (gp && padEdge(gp, BTN.LB)) fireState.reloadEdge = true

    // --- reload ---
    if (fireState.reloading) {
      fireState.reloadT += Math.min(0.016, 0.05)
      if (fireState.reloadT >= fireState.reloadDur) {
        fireState.reloading = false
        st.reloadWeapon()
      }
      return
    }
    if (fireState.reloadEdge && wrec && wrec.mag < wdef.mag && wrec.reserve > 0) {
      fireState.reloading = true
      fireState.reloadT = 0
      fireState.reloadDur = wdef.melee ? 0.4 : 1.6
      audio.play(wdef.melee ? 'melee' : 'reload')
    }
    fireState.reloadEdge = false

    // --- fire gating ---
    const want = fireState.wantFire
    if (!want || !wrec || wrec.mag < 0) {
      if (!want) fireState.fireCooldown = 0
      return
    }
    if (wrec.mag <= 0) {
      if (wrec.reserve > 0) { fireState.reloading = true; fireState.reloadT = 0; fireState.reloadDur = wdef.melee ? 0.4 : 1.6 }
      fireState.wantFire = false
      return
    }

    fireState.fireCooldown -= 0.016
    if (fireState.fireCooldown > 0) {
      if (!wdef.auto) fireState.wantFire = false
      return
    }
    fireState.fireCooldown = wdef.cooldown
    st.spendMag()

    // --- aim: camera forward + spread ---
    aimVec.set(0, 0, -1).applyQuaternion(camera.quaternion)
    aimVec.y = Math.max(-0.85, Math.min(0.85, aimVec.y))
    aimVec.normalize()
    if (wdef.spread > 0) {
      const theta = Math.random() * Math.PI * 2
      const phi = wdef.spread * Math.sqrt(Math.random())
      jit.set(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi))
      aimVec.add(jit).normalize()
    }

    // --- ray origin (muzzle if mounted, else camera) ---
    originScratch.copy(camera.position)
    let muzzleOk = false
    if (gunFX.getMuzzle) {
      const ok = gunFX.getMuzzle(mpScratch)
      if (ok) { originScratch.copy(mpScratch); muzzleOk = true }
    }

    // --- two-stage aim (crosshair fidelity) ---
    // Firing the hit ray from the MUZZLE along the CAMERA direction misses
    // close targets by the arm offset: the muzzle sits ~0.4 m off the view
    // axis, so the ray is parallel to the view but shifted sideways —
    // measured headlessly as impacts 1.8-3.2 m beside a ped 3.7 m away whose
    // capsule is only 0.35 m across (scripts/rayprobe.mjs proves the capsule
    // itself IS hit — a straight ray reads toi 2.65 from 3 m). Standard
    // third-person solution: (1) aim point = where the CAMERA ray lands
    // (hit or max range), then (2) hit ray = muzzle -> aim point. The
    // crosshair stays true, the tracer still leaves the muzzle, and muzzle
    // occlusion (can't shoot through a wall you're hugging) stays honest.
    let aimToi = wdef.range
    {
      let aimRay = null
      try {
        aimRay = new rapier.Ray(
          { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          { x: aimVec.x, y: aimVec.y, z: aimVec.z },
        )
      } catch (e) {
        aimRay = null
      }
      if (aimRay) {
        let res = null
        try {
          res = world.castRay(aimRay, wdef.range, true)
        } catch (e) {
          res = null
        }
        try {
          if (typeof aimRay.free === 'function') aimRay.free()
        } catch (e) { /* ignore */ }
        if (res) aimToi = res.toi ?? res.timeOfImpact ?? wdef.range
      }
    }
    endPt.copy(camera.position).addScaledVector(aimVec, aimToi)
    let dirX = aimVec.x
    let dirY = aimVec.y
    let dirZ = aimVec.z
    if (muzzleOk) {
      jit.copy(endPt).sub(originScratch)
      const jl = jit.length() || 1
      jit.multiplyScalar(1 / jl)
      dirX = jit.x
      dirY = jit.y
      dirZ = jit.z
    }

    let hit = null
    let rayObj = null
    try {
      rayObj = new rapier.Ray(
        { x: originScratch.x, y: originScratch.y, z: originScratch.z },
        { x: dirX, y: dirY, z: dirZ },
      )
    } catch (e) {
      rayObj = null
    }
    if (rayObj) {
      let res = null
      try {
        res = world.castRay(rayObj, wdef.range, true)
      } catch (e) {
        res = null
      }
      try {
        if (typeof rayObj.free === 'function') rayObj.free()
      } catch (e) { /* ignore */ }
      if (res) {
        const toi = res.toi ?? res.timeOfImpact ?? wdef.range
        endPt.copy(originScratch).addScaledVector(jit.set(dirX, dirY, dirZ), toi)
        hit = { x: endPt.x, y: endPt.y, z: endPt.z, dist: toi }
      }
    }
    if (!hit) endPt.copy(originScratch).addScaledVector(jit.set(dirX, dirY, dirZ), wdef.range)
    fireTracer(originScratch.x, originScratch.y, originScratch.z, endPt.x, endPt.y, endPt.z)
    audio.play(wdef.melee ? 'melee' : 'shoot')
    if (muzzleOk) muzzleFlash(originScratch.x, originScratch.y, originScratch.z)
    if (hit) impactFlash(hit.x, hit.y, hit.z)
    shotTrace.shots += 1
    shotTrace.muzzle = muzzleOk ? 1 : 0
    shotTrace.toi = hit ? hit.dist : -1
    shotTrace.ox = originScratch.x
    shotTrace.oy = originScratch.y
    shotTrace.oz = originScratch.z
    const pb = bodyRef && bodyRef.current
    if (pb && typeof pb.translation === 'function') {
      try {
        const pt = pb.translation()
        shotTrace.px = pt.x
        shotTrace.py = pt.y
        shotTrace.pz = pt.z
      } catch (e) { /* noop */ }
    }
    if (hit) {
      shotTrace.impacts += 1
      shotTrace.x = hit.x
      shotTrace.y = hit.y
      shotTrace.z = hit.z
    }

    // --- hit test NPCs by proximity to impact ---
    if (hit) {
      for (let k = 0; k < NPC_RECORDS.length; k++) {
        const nr = NPC_RECORDS[k]
        if (!nr || nr.dead || !nr.rb || typeof nr.rb.translation !== 'function') continue
        const bt = nr.rb.translation()
        const dx = bt.x - hit.x
        const dz = bt.z - hit.z
        // The ped's RigidBody origin IS its capsule CENTER (Npcs.jsx puts the
        // body at y=0.95 with a 0.6 half-height + 0.35 radius capsule), so the
        // chest reference height is just bt.y. The old `bt.y + 0.95` put the
        // 1.6 m hit sphere center at ~1.9 m — above the ped's head — so shots
        // that landed on the legs / the ground beside a ped never registered
        // and pedestrians looked invulnerable point-blank.
        const dy = bt.y - hit.y
        if (dx * dx + dy * dy + dz * dz < 2.56) {
          shotTrace.hits += 1
          st.setHitAt(performance.now())
          const dmg = wdef.damage || (wdef.melee ? 15 : 0)
          nr.hp = Math.max(0, nr.hp - dmg)
          if (nr.hp <= 0) {
            nr.dead = true
            nr.deadAt = performance.now()
            nr.killer = 'player'
            st.addKill()
          }
          break
        }
      }
    }

    gunFX.recoil = Math.min(1, (gunFX.recoil || 0) + 0.35)
    if (!wdef.auto) fireState.wantFire = false
  })

  // Purely 3D output: this component lives INSIDE <Canvas>, so it must never
  // return a DOM host element. The reload bar is rendered by the DOM overlay
  // (ui/Inventory.jsx, #gtathens-reload) and written imperatively via
  // setReloadUI above.
  return equipped && equipped !== 'fists' && def ? <GunMount weaponId={equipped} /> : null
}

export default WeaponController

