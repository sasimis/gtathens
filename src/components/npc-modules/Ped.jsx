import React, { useEffect, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { CapsuleCollider, RigidBody } from '@react-three/rapier'
import useGameStore, { Phase } from '../../store/useGameStore'
import { navPath, navRandomPointAround } from '../../lib/navmesh'
import { navRuntime } from '../CityNavMesh'
import { spawnDrop } from '../Pickups'
import Protagonist, { CHARACTERS } from '../Protagonist'
import { NPC_KILL_TOAST, NPC_RECORDS, PED_GROUPS, PED_SPEED } from './npcState'
import { setKb } from './pedestrianUtils'

export const Ped = ({ index, x, z, dir }) => {
  const bodyRef = useRef(null)
  const gRef = useRef(null)
  const rec = NPC_RECORDS[index]
  const [action, setAction] = useState('idle')
  const st = useRef({ px: x, pz: z, yaw: dir, deadNotified: false, wob: Math.random() * 9 })
  const s = st.current

  useEffect(() => {
    if (rec) rec.rb = bodyRef.current
    return () => { if (rec && rec.rb === bodyRef.current) rec.rb = null }
  }, [rec])

  useEffect(() => {
    if (rec && !rec.dead) {
      s.px = x
      s.pz = z
      s.yaw = dir
      s.deadNotified = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, z])

  useFrame((state, dtRaw) => {
    const rb = bodyRef.current
    if (!rb || !rec) return
    const dt = Math.min(dtRaw, 0.05)
    const gs = useGameStore.getState()
    if (rec.dead) {
      try {
        const t = rb.translation()
        setKb(rb, t.x, Math.max(0, t.y - dt * 1.6), t.z)
      } catch (e) { /* noop */ }
      if (!s.deadNotified) {
        s.deadNotified = true
        try {
          const t = rb.translation()
          spawnDrop('money', t.x, t.z, 8 + Math.floor(Math.random() * 30))
          spawnDrop('ammo', t.x + 0.5, t.z + 0.4, 12 + Math.floor(Math.random() * 24))
        } catch (e) { /* noop */ }
        if (gs.pushToast) gs.pushToast(NPC_KILL_TOAST, 'info')
        setAction('idle')
      }
      return
    }
    if (gs.phase !== Phase.PLAYING) return
    s.wob += dt
    const wob = Math.sin(s.wob * 0.9) * 0.35
    let heading
    if (navRuntime.ready && navRuntime.query) {
      if (!s.navPath && (s.navAt == null || s.wob - s.navAt > 1.5)) {
        s.navAt = s.wob
        const t = navRandomPointAround(navRuntime.query, s.px, s.pz, 22, (index * 8191 + Math.floor(s.wob * 7)) | 0)
        if (t) {
          const p = navPath(navRuntime.query, [s.px, s.pz], [t.x, t.z])
          if (p.found && p.points.length > 1) {
            s.navPath = p.points
            s.navI = 1
          }
        }
      }
      const wp = s.navPath ? s.navPath[s.navI] : null
      if (wp) {
        const wx = wp[0] - s.px
        const wz = wp[1] - s.pz
        if (Math.hypot(wx, wz) < 1.0) {
          s.navI += 1
          if (s.navI >= s.navPath.length) {
            s.navPath = null
            s.navAt = s.wob - 1.4
          }
        } else {
          heading = Math.atan2(wx, wz) + wob * 0.3
        }
      }
      if (s.navPath && s.wob - (s.navAt || 0) > 12) s.navPath = null
    }
    if (heading === undefined) heading = s.yaw + wob
    s.yaw = heading
    let nx = s.px + Math.sin(heading) * PED_SPEED * dt
    let nz = s.pz + Math.cos(heading) * PED_SPEED * dt
    try {
      const t = rb.translation()
      const pushed = Math.hypot(t.x - s.px, t.z - s.pz)
      if (pushed > 0.08 && pushed < 6) {
        nx = t.x + Math.sin(s.yaw) * PED_SPEED * dt
        nz = t.z + Math.cos(s.yaw) * PED_SPEED * dt
        if (Math.abs(pushed - PED_SPEED * dt) > 0.02) s.yaw += dt * 1.0
      }
    } catch (e) { /* noop */ }
    if (!s.navPath && Math.random() < dt * 0.03) s.yaw += (Math.random() - 0.5) * 1.2
    s.px = nx
    s.pz = nz
    try {
      const t = rb.translation()
      const y = Number.isFinite(t.y) ? Math.max(0, Math.min(3, t.y)) : 0
      setKb(rb, nx, y, nz)
    } catch (e) { /* noop */ }
    if (action !== 'run') setAction('run')
    if (gRef.current) {
      gRef.current.position.set(nx, 0, nz)
      gRef.current.rotation.set(0, s.yaw, 0)
    }
  })

  return (
    <group ref={gRef} position={[x, 0, z]} rotation={[0, dir, 0]}>
      <RigidBody
        ref={bodyRef}
        type="kinematicPosition"
        colliders={false}
        position={[0, 0.95, 0]}
        collisionGroups={PED_GROUPS}
      >
        <CapsuleCollider args={[0.6, 0.35]} />
      </RigidBody>
      <Protagonist
        action={rec && rec.dead ? 'idle' : action}
        animSpeed={1}
        skin={(CHARACTERS[(index + 1) % CHARACTERS.length] || {}).skin || null}
      />
    </group>
  )
}
