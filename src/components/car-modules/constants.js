
// car-modules/constants.js
export const UNIT = 0.01
export const PARK_COUNT = 26
export const PARK_RADIUS = 280

export const CAR_IDS = [
  'sedan','taxi','hatchback','sports','roadster','muscle','muscle-2',
  'suv','pickup','van','ambulance','bus','firetruck','truck',
  'truck-with-trailer','limousine','police-sedan','police-muscle',
  'police-sports','police-suv','monster-truck',
]

export const HALF = {
  sedan:[1.4,1.0,2.6], taxi:[1.4,1.0,2.6], hatchback:[1.35,1.0,2.5],
  sports:[1.4,0.9,2.6], roadster:[1.4,0.9,2.6],
  muscle:[1.4,1.0,2.7], 'muscle-2':[1.4,1.0,2.7],
  suv:[1.5,1.2,2.8], pickup:[1.5,1.15,2.9],
  van:[1.5,1.35,3.1], ambulance:[1.5,1.35,3.3],
  bus:[1.9,2.1,6.9], firetruck:[1.7,1.6,4.4],
  truck:[1.7,1.6,4.2], 'truck-with-trailer':[1.7,2.0,6.8],
  limousine:[1.4,1.0,3.6], 'police-sedan':[1.4,1.0,2.6],
  'police-muscle':[1.4,1.0,2.7], 'police-sports':[1.4,0.9,2.6],
  'police-suv':[1.5,1.2,2.8], 'monster-truck':[1.9,1.7,3.0],
}

export const LONG_IDS = new Set(['bus','truck-with-trailer','firetruck','limousine'])

// Rapier collision groups
export const GROUP_GROUND = 0x0001
export const GROUP_PLAYER = 0x0002
export const GROUP_CAR = 0x0004
export const GROUP_BUILDING = 0x0008
export const FILTER_ALL = GROUP_GROUND | GROUP_PLAYER | GROUP_CAR | GROUP_BUILDING
export const CAR_COLLISION_GROUPS = GROUP_CAR | (FILTER_ALL << 16)
export const PLAYER_COLLISION_GROUPS = GROUP_PLAYER | (FILTER_ALL << 16)

// Crash tuning
export const HIT_SPEED_MIN = 1.2
export const HIT_FORCE_MIN = 20000
export const HIT_DEBOUNCE_MS = 250
export const PUSH_MIN = 2.5
export const PUSH_MAX = 12
export const LOOSE_MAX_MS = 6000

// Driving tuning
export const CAR_MAX_SPEED = 17
export const CAR_REVERSE_MAX = 7
export const CAR_TURN_RATE = 2.2

export const CAR_TUNING = {
  sports: { maxSpeed: 24, reverseMax: 9.5, turnRate: 2.7, accelTau: 0.24, grip: 0.90 },
  roadster: { maxSpeed: 23, reverseMax: 9, turnRate: 2.7, accelTau: 0.25, grip: 0.90 },
  'police-sports': { maxSpeed: 24, reverseMax: 9.5, turnRate: 2.7, accelTau: 0.24, grip: 0.90 },
  muscle: { maxSpeed: 22, reverseMax: 8.5, turnRate: 2.5, accelTau: 0.28, grip: 0.87 },
  'muscle-2': { maxSpeed: 22, reverseMax: 8.5, turnRate: 2.5, accelTau: 0.28, grip: 0.87 },
  'police-muscle': { maxSpeed: 22, reverseMax: 8.5, turnRate: 2.5, accelTau: 0.28, grip: 0.87 },
  sedan: { maxSpeed: 19, reverseMax: 7.5, turnRate: 2.4, accelTau: 0.30, grip: 0.91 },
  taxi: { maxSpeed: 19, reverseMax: 7.5, turnRate: 2.4, accelTau: 0.30, grip: 0.91 },
  hatchback: { maxSpeed: 18, reverseMax: 7.5, turnRate: 2.5, accelTau: 0.29, grip: 0.91 },
  'police-sedan': { maxSpeed: 20, reverseMax: 8, turnRate: 2.5, accelTau: 0.28, grip: 0.91 },
  suv: { maxSpeed: 18, reverseMax: 7, turnRate: 2.2, accelTau: 0.33, grip: 0.88 },
  pickup: { maxSpeed: 18, reverseMax: 7, turnRate: 2.2, accelTau: 0.33, grip: 0.88 },
  'police-suv': { maxSpeed: 19, reverseMax: 7.5, turnRate: 2.3, accelTau: 0.31, grip: 0.89 },
  van: { maxSpeed: 17, reverseMax: 6.5, turnRate: 2.1, accelTau: 0.35, grip: 0.89 },
  ambulance: { maxSpeed: 17, reverseMax: 6.5, turnRate: 2.1, accelTau: 0.35, grip: 0.89 },
  bus: { maxSpeed: 15, reverseMax: 5.5, turnRate: 1.8, accelTau: 0.42, grip: 0.93 },
  firetruck: { maxSpeed: 15, reverseMax: 5.5, turnRate: 1.8, accelTau: 0.42, grip: 0.93 },
  truck: { maxSpeed: 16, reverseMax: 6, turnRate: 1.9, accelTau: 0.39, grip: 0.93 },
  'truck-with-trailer': { maxSpeed: 14, reverseMax: 5, turnRate: 1.7, accelTau: 0.44, grip: 0.93 },
  limousine: { maxSpeed: 18, reverseMax: 6.5, turnRate: 2.0, accelTau: 0.36, grip: 0.89 },
  'monster-truck': { maxSpeed: 19, reverseMax: 7.5, turnRate: 2.4, accelTau: 0.30, grip: 0.85 },
}

export const getCarTuning = (id) => {
  const key = id ? id.toLowerCase() : 'sedan'
  return CAR_TUNING[key] || { maxSpeed: CAR_MAX_SPEED, reverseMax: CAR_REVERSE_MAX, turnRate: CAR_TURN_RATE, accelTau: 0.35, grip: 0.90 }
}
