// car-modules/constants.js
// KayKit-style GLB car pack (public/models/cars/*.glb): authored in meters,
// Y-up, wheels on y=0, nose along +Z. HALF comes from the models' measured
// world-space bboxes (scripts/car-lab.mjs + carlab-boxes.json).
export const PARK_COUNT = 26
export const PARK_RADIUS = 280

export const CAR_IDS = [
  'sedan', 'sedan-blue', 'sedan-darkred',
  'sports', 'sports-yellow', 'sports-stripe',
  'muscle', 'muscle-black', 'muscle-green', 'muscle-teal',
  'suv', 'suv-black', 'suv-green', 'suv-teal',
  'suv-yellow', 'suv-blue', 'suv-orange', 'suv-red',
]

export const HALF = {
  sedan: [0.95, 0.71, 2.49], 'sedan-blue': [0.9, 0.71, 2.41],
  'sedan-darkred': [0.9, 0.71, 2.41],
  sports: [0.95, 0.72, 2.49], 'sports-yellow': [0.95, 0.72, 2.49],
  'sports-stripe': [0.95, 0.71, 2.49],
  muscle: [1.0, 0.77, 2.35], 'muscle-black': [0.9, 0.69, 2.41],
  'muscle-green': [1.0, 0.77, 2.35], 'muscle-teal': [1.0, 0.79, 2.35],
  suv: [1.19, 1.02, 2.6], 'suv-black': [1.19, 1.02, 2.6],
  'suv-green': [1.19, 1.02, 2.6], 'suv-teal': [1.19, 1.0, 2.55],
  'suv-yellow': [1.19, 1.01, 2.55], 'suv-blue': [1.19, 1.01, 2.55],
  'suv-orange': [1.19, 1.02, 2.6], 'suv-red': [1.19, 1.02, 2.6],
}

// Nothing in the new pack is oversized (longest = 5.2 m SUV) — kept as an
// empty set so useParkingSpots' long-vehicle substitution is a no-op.
export const LONG_IDS = new Set([])

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
  if (!id) return CAR_TUNING.sedan
  const key = id.toLowerCase()
  if (CAR_TUNING[key]) return CAR_TUNING[key]
  const base = key.split('-')[0]
  if (CAR_TUNING[base]) return CAR_TUNING[base]
  return { maxSpeed: CAR_MAX_SPEED, reverseMax: CAR_REVERSE_MAX, turnRate: CAR_TURN_RATE, accelTau: 0.30, grip: 0.90 }
}