// Weapon controller: firing, recoil/bloom, ammo, reload, weapon switching,
// hit tests (capsule hitboxes + headshots), fist melee.
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
  setFiring,
} from '../lib/combat'
import { BTN, getGamepad, padValue, padEdge } from '../lib/gamepad'
import { GunMount } from './Weapon'
import { muzzleFlash } from './BulletFx'
import { NPC_RECORDS } from './Npcs'
import { audio } from '../lib/audio'
import {
  AIM_MAX,
  applyAimAssist,
  damagePed,
  fireBullet,
  FISTS_DEF,
  setReloadUI,
  shotTrace,
} from './weapon-modules/weaponCombat'
import { castWorld, selfColliderHandle, worldHit } from './weapon-modules/weaponRaycast'

// Module scratch (no allocation inside useFrame)
const aimDir = new THREE.Vector3()
const aimPoint = new THREE.Vector3()
const muzzleVec = new THREE.Vector3()
const shotDir = new THREE.Vector3()
const rightVec = new THREE.Vector3()
const upVec = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

const aimAssistDir = { x: 0, y: 0, z: 0 }
let aimReach = 0
let aimAssisted = false
const fireCtx = { world: null, rapier: null, bodyRef: null }

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

const fxOnce = { tracer: false }
const damageOnce = { n: false }

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

  useEffect(() => {
    combatReset()
    gunFX.recoil = 0
  }, [equipped])

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
        bloom01: +combat.bloom01.toFixed(3),
        recoil: +combat.recoil.toFixed(2),
      }
    }
    return () => { delete window.__gtathensMuzzle }
  }, [])

  useFrame((state, delta) => {
    const dt = Math.min(Math.max(delta, 0), 0.05)
    decayCombat(dt)

    const st = useGameStore.getState()
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

    if (st.weaponChangeLeft > 0) st.drainWeaponChange(dt)

    const eq = st.equipped
    const isFists = eq === 'fists'
    const wdef = isFists ? FISTS_DEF : WEAPONS[eq]
    if (!wdef) return
    const wrec = isFists
      ? { id: 'fists', mag: 99, reserve: 99 }
      : st.weapons.find((x) => x.id === eq) || null

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

    if (combat.touchFire) {
      combat.assist = true
      fireState.wantFire = true
    }

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
    combat.reload01 = 0
    if (!isFists && fireState.reloadEdge && wrec && wrec.mag < wdef.mag && wrec.reserve > 0) {
      fireState.reloading = true
      fireState.reloadT = 0
      fireState.reloadDur = Number.isFinite(wdef.reloadTime) ? wdef.reloadTime : 1.6
      combat.reloading = true
      audio.play('reload')
    }
    fireState.reloadEdge = false

    if (!isFists && gunFX.held) {
      aimDir.set(mouseAim.nx, mouseAim.ny, 0.5).unproject(camera).sub(camera.position)
      if (aimDir.lengthSq() < 1e-8) aimDir.set(0, 0, -1).applyQuaternion(camera.quaternion)
      aimDir.y = Math.max(-0.85, Math.min(0.85, aimDir.y))
      aimDir.normalize()
      const camX = camera.position.x
      const camY = camera.position.y
      const camZ = camera.position.z

      aimAssistDir.x = aimDir.x
      aimAssistDir.y = aimDir.y
      aimAssistDir.z = aimDir.z
      aimAssisted = applyAimAssist(aimAssistDir, camX, camY, camZ, wdef.range || 90)
      aimDir.set(aimAssistDir.x, aimAssistDir.y, aimAssistDir.z)

      const reticleMax = Math.min(AIM_MAX, wdef.range || 90)
      let aimToi = reticleMax
      if (castWorld(
        world, rapier, camX, camY, camZ, aimDir.x, aimDir.y, aimDir.z,
        reticleMax, selfColliderHandle(bodyRef),
      )) {
        aimToi = Math.min(worldHit.toi, reticleMax)
      }
      aimPoint.set(camX + aimDir.x * aimToi, camY + aimDir.y * aimToi, camZ + aimDir.z * aimToi)
      aimReach = aimToi

      combat.aimX = aimPoint.x
      combat.aimY = aimPoint.y
      combat.aimZ = aimPoint.z
      combat.aimOk = true
    } else {
      combat.aimOk = false
      aimReach = 0
      aimAssisted = false
    }

    const want = fireState.wantFire
    setFiring(want && st.weaponChangeLeft <= 0)

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
    if (!isFists) st.spendMag()
    const now = performance.now()

    if (isFists) {
      window.__gtathensPunchT = 0.35
      audio.play('melee')
      fireState.wantFire = false
      combat.aimHold = 0.3
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
        let bestD = 3.2
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

    noteShot(wdef, now)
    combat.spread = coneFor(wdef)
    const cone = combat.spread
    const span = (wdef.spreadMax || 0) - (wdef.spread || 0)
    combat.bloom01 = span > 0 ? Math.min(1, combat.bloom / span) : combat.bloom > 0 ? 1 : 0
    gunFX.recoil = 1
    gunFX.kick = Number.isFinite(wdef.recoilKick) ? wdef.recoilKick : 0.04

    const muzzleOk = !!(gunFX.getMuzzle && gunFX.getMuzzle(muzzleVec))
    const ox = muzzleOk ? muzzleVec.x : camera.position.x
    const oy = muzzleOk ? muzzleVec.y : camera.position.y
    const oz = muzzleOk ? muzzleVec.z : camera.position.z

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
      fxOnce.tracer = true
    }

    muzzleFlash(ox, oy, oz)
    audio.play('shoot')
    if (damageOnce.n) audio.play('hit')

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

    if (modelRef && modelRef.current) {
      modelRef.current.rotation.x = -combat.recoil * 0.045
    }
    if (!wdef.auto) fireState.wantFire = false
  })

  return equipped && equipped !== 'fists' && def ? <GunMount weaponId={equipped} /> : null
}

export * from './weapon-modules'
export { shotTrace }
export default WeaponController
