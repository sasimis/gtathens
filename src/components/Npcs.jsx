// Pedestrians + AI traffic. Peds are kinematic capsules; HP lives on the
// MODULE record (NPC_RECORDS) - WeaponController hits set dead, render does
// fall + drops via spawnDrop(). Traffic loops the road graph.
import React, { useEffect, useState } from 'react'
import { hash01, loadWorldData } from '../lib/worldData'
import { NPC_HP } from '../lib/weapons'
import {
  AI_CAR_COUNT,
  AI_CAR_STATE,
  AiCar,
  AiTrafficDebug,
  buildAiRoutes,
  buildPedSpawns,
  NPC_RECORDS,
  Ped,
  PED_COUNT,
} from './npc-modules'

const Npcs = ({ spawn = [0, 0] }) => {
  const key = `${Math.round(spawn[0] * 10)},${Math.round(spawn[1] * 10)}`
  const [peds, setPeds] = useState([])
  const [routes, setRoutes] = useState([])

  useEffect(() => {
    let cancelled = false
    for (const r of NPC_RECORDS) {
      r.hp = NPC_HP
      r.dead = false
      r.deadAt = 0
      r.killer = null
    }
    AI_CAR_STATE.length = 0
    loadWorldData()
      .then((data) => {
        if (cancelled) return
        const spots = buildPedSpawns(data, spawn, PED_COUNT)
        setPeds(spots.map((p, i) => ({ ...p, dir: hash01(i * 31 + 3) * Math.PI * 2 })))
        const rts = buildAiRoutes(data, spawn, AI_CAR_COUNT)
        for (let i = 0; i < rts.length; i += 1) AI_CAR_STATE.push({ route: i })
        setRoutes(rts)
      })
      .catch((err) => console.error('npcs: map load failed', err))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <>
      {peds.map((p, i) => (
        <Ped key={`${key}-${i}`} index={i} x={p.x} z={p.z} dir={p.dir} />
      ))}
      {routes.map((r, i) => (
        <AiCar key={`${key}-car-${i}`} route={r} seed={i} index={i} />
      ))}
      <AiTrafficDebug />
    </>
  )
}

export * from './npc-modules'
export { AiTrafficDebug }
export default Npcs
