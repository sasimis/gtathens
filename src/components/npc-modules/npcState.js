import { NPC_HP } from '../../lib/weapons'

export const PED_COUNT = 10
export const PED_RADIUS = 200
export const AI_CAR_COUNT = 8
export const AI_CAR_RADIUS = 280
export const NPC_KILL_TOAST = 'Ped down - cash dropped'

export const NPC_RECORDS = []
export const AI_CAR_STATE = []
export const AI_ROUTES = []

for (let i = 0; i < PED_COUNT; i += 1) {
  NPC_RECORDS.push({ i, kind: 'ped', hp: NPC_HP, dead: false, deadAt: 0, killer: null, rb: null })
}

export const PED_SPEED = 1.5
export const AI_CRUISE = 10

export const GROUP_GROUND = 0x0001
export const GROUP_PLAYER = 0x0002
export const GROUP_CAR = 0x0004
export const GROUP_BUILDING = 0x0008

export const PED_GROUPS = GROUP_PLAYER | ((GROUP_GROUND | GROUP_PLAYER | GROUP_CAR | GROUP_BUILDING) << 16)
export const AI_CAR_GROUPS = GROUP_CAR | ((GROUP_GROUND | GROUP_PLAYER | GROUP_CAR | GROUP_BUILDING) << 16)

export const npcsQA = {
  count: () => NPC_RECORDS.length,
  ped: (i) => {
    const r = NPC_RECORDS[i]
    if (!r) return null
    let x = 0
    let y = 0
    let z = 0
    if (r.rb && typeof r.rb.translation === 'function') {
      try {
        const t = r.rb.translation()
        x = t.x
        y = t.y
        z = t.z
      } catch (e) { /* noop */ }
    }
    return { x, y, z, hp: r.hp, dead: !!r.dead }
  },
  aliveCount: () => NPC_RECORDS.reduce((n, r) => n + (r.dead ? 0 : 1), 0),
  /** Index of the living ped nearest to (x, z), or -1. */
  nearest: (x, z) => {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < NPC_RECORDS.length; i += 1) {
      const r = NPC_RECORDS[i]
      if (!r || r.dead || !r.rb || typeof r.rb.translation !== 'function') continue
      let t = null
      try {
        t = r.rb.translation()
      } catch (e) {
        t = null
      }
      if (!t) continue
      const d = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  },
}

if (typeof window !== 'undefined') window.__gtathensNpcs = npcsQA
