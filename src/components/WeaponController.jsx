// Weapon controller: firing, recoil, ammo, reload, weapon switching, hit tests, fist melee.
import React, { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useKeyboardControls } from '@react-three/drei'
import { useRapier } from '@react-three/rapier'
import * as THREE from 'three'
import useGameStore, { Phase } from '../store/useGameStore'
import { WEAPONS, gunFX } from '../lib/weapons'
import { mouseAim } from '../lib/aim'
import { BTN, getGamepad, padValue, padEdge } from '../lib/gamepad'
import { GunMount } from './Weapon'
import { fireTracer, muzzleFlash, impactFlash } from './BulletFx'
import { NPC_RECORDS } from './Npcs'
import { audio } from '../lib/audio'

const aimVec = new THREE.Vector3()
const originScratch = new THREE.Vector3()
const mpScratch = new THREE.Vector3()
const endPt = new THREE.Vector3()
const jit = new THREE.Vector3()

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
  if (reloadEl.hidden === on) reloadEl.hidden = !on
  if (!on) return
  const fill = reloadEl.firstElementChild
  if (fill) fill.style.width = `${Math.round(Math.min(1, pct) * 100)}%`
}

export const shotTrace = { shots: 0, impacts: 0, hits: 0, x: 0, y: 0, z: 0, toi: -1, muzzle: 0, ox: 0, oy: 0, oz: 0, px: 0, py: 0, pz: 0 }
if (typeof window !== 'undefined') window.__gtathensShot = shotTrace

const WeaponController = ({ bodyRef, modelRef, camYaw }) => {
  const { world, rapier } = useRapier()
  const { camera } = useThree()
  const [, getKeys] = useKeyboardControls()
  const prevKeys = useRef({})

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
  }, [phase, inventoryOpen, driving])

  useFrame(() => {
    const st = useGameStore.getState()
    setReloadUI(fireState.reloading ? fireState.reloadT / fireState.reloadDur : 0)
    if (!world || st.phase !== Phase.PLAYING) {
      if (st.phase !== Phase.PLAYING) { fireState.wantFire = false; fireState.reloadEdge = false }
      return
    }

    // --- Weapon-switch cooldown drain (seconds) ---
    if (st.weaponChangeLeft > 0) {
      st.drainWeaponChange(0.016)
    }

    const eq = st.equipped
    const isFists = eq === 'fists'
    const wdef = isFists ? { name: 'Fists', cooldown: 0.38, damage: 20, melee: true } : WEAPONS[eq]
    if (!wdef) return
    const wrec = isFists ? { id: 'fists', mag: 99, reserve: 99 } : st.weapons.find((x) => x.id === eq) || null

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
      if (!fireState.mouseDown) fireState.wantFire = false
    }

    // --- gamepad RT ---
    const gp = getGamepad()
    if (gp) {
      const rt = padValue(gp, BTN.RT) || (padEdge(gp, BTN.X) ? 1 : 0)
      if (rt > 0.2) fireState.wantFire = true
      else if (rt <= 0.15 && !fireState.kbWasDown && !fireState.mouseDown) {
        fireState.wantFire = false
      }
    }
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
    if (!isFists && fireState.reloadEdge && wrec && wrec.mag < wdef.mag && wrec.reserve > 0) {
      fireState.reloading = true
      fireState.reloadT = 0
      fireState.reloadDur = wdef.melee ? 0.4 : 1.6
      audio.play(wdef.melee ? 'melee' : 'reload')
    }
    fireState.reloadEdge = false

    // --- fire / attack gating ---
    const want = fireState.wantFire
    // While swapping weapons, suppress fire but keep the cooldown ticking down.
    if (st.weaponChangeLeft > 0) {
      return
    }
    if (!want || !wrec || wrec.mag < 0) {
      if (!want) fireState.fireCooldown = 0
      return
    }
    if (!isFists && wrec.mag <= 0) {
      if (wrec.reserve > 0) { fireState.reloading = true; fireState.reloadT = 0; fireState.reloadDur = 1.6 }
      fireState.wantFire = false
      return
    }

    fireState.fireCooldown -= 0.016
    if (fireState.fireCooldown > 0) {
      if (!wdef.auto) fireState.wantFire = false
      return
    }
    fireState.fireCooldown = wdef.cooldown
    if (!isFists) st.spendMag()

    // --- Fist Attack Execution ---
    if (isFists) {
      window.__gtathensPunchT = 0.35 // Trigger arm swing in Protagonist
      audio.play('melee')
      fireState.wantFire = false

      // Proximity melee hit detection in front of player
      const pb = bodyRef && bodyRef.current
      if (pb && typeof pb.translation === 'function') {
        const pt = pb.translation()
        for (let k = 0; k < NPC_RECORDS.length; k++) {
          const nr = NPC_RECORDS[k]
          if (!nr || nr.dead || !nr.rb || typeof nr.rb.translation !== 'function') continue
          const bt = nr.rb.translation()
          const dx = bt.x - pt.x
          const dz = bt.z - pt.z
          const dy = bt.y - pt.y
          if (dx * dx + dy * dy + dz * dz < 3.2) {
            st.setHitAt(performance.now())
            audio.play('crash')
            nr.hp = Math.max(0, nr.hp - wdef.damage)
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
      return
    }

    // --- Gun Aiming & Firing ---
    // Aim from the CURSOR: unproject the crosshair's NDC through the live
    // camera (mouseAim is written by Crosshair.jsx on mousemove). No mouse
    // yet (or headless smoke test) -> fall back to screen center, i.e. the
    // old camera-forward ray, so X-key bursts still fly straight ahead.
    aimVec.set(mouseAim.nx, mouseAim.ny, 0.5).unproject(camera).sub(camera.position).normalize()
    if (aimVec.lengthSq() < 1e-8) aimVec.set(0, 0, -1).applyQuaternion(camera.quaternion)
    aimVec.y = Math.max(-0.85, Math.min(0.85, aimVec.y))
    aimVec.normalize()
    if (wdef.spread > 0) {
      const theta = Math.random() * Math.PI * 2
      const phi = wdef.spread * Math.sqrt(Math.random())
      jit.set(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi))
      aimVec.add(jit).normalize()
    }

    originScratch.copy(camera.position)
    let muzzleOk = false
    if (gunFX.getMuzzle) {
      const ok = gunFX.getMuzzle(mpScratch)
      if (ok) { originScratch.copy(mpScratch); muzzleOk = true }
    }

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

    if (hit) {
      shotTrace.impacts += 1
      shotTrace.x = hit.x
      shotTrace.y = hit.y
      shotTrace.z = hit.z

      for (let k = 0; k < NPC_RECORDS.length; k++) {
        const nr = NPC_RECORDS[k]
        if (!nr || nr.dead || !nr.rb || typeof nr.rb.translation !== 'function') continue
        const bt = nr.rb.translation()
        const dx = bt.x - hit.x
        const dz = bt.z - hit.z
        const dy = bt.y - hit.y
        if (dx * dx + dy * dy + dz * dz < 2.56) {
          shotTrace.hits += 1
          st.setHitAt(performance.now())
          const dmg = wdef.damage || 15
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

  return equipped && equipped !== 'fists' && def ? <GunMount weaponId={equipped} /> : null
}

export default WeaponController
