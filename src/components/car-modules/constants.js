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
export const PUSH_MIN = 3.0
export const PUSH_MAX = 14
export const LOOSE_MAX_MS = 6000

// Driving tuning
export const CAR_MAX_SPEED = 21
export const CAR_REVERSE_MAX = 8.5
export const CAR_TURN_RATE = 2.5

export const CAR_TUNING = {
  sports: { maxSpeed: 28, reverseMax: 10, turnRate: 2.9, accelTau: 0.22, grip: 0.92 },
  roadster: { maxSpeed: 27, reverseMax: 9.5, turnRate: 2.9, accelTau: 0.23, grip: 0.92 },
  'police-sports': { maxSpeed: 28, reverseMax: 10, turnRate: 2.9, accelTau: 0.22, grip: 0.92 },
  muscle: { maxSpeed: 26, reverseMax: 9, turnRate: 2.7, accelTau: 0.25, grip: 0.88 },
  'muscle-2': { maxSpeed: 26, reverseMax: 9, turnRate: 2.7, accelTau: 0.25, grip: 0.88 },
  'police-muscle': { maxSpeed: 26, reverseMax: 9, turnRate: 2.7, accelTau: 0.25, grip: 0.88 },
  sedan: { maxSpeed: 22, reverseMax: 8.5, turnRate: 2.5, accelTau: 0.27, grip: 0.92 },
  taxi: { maxSpeed: 22, reverseMax: 8.5, turnRate: 2.5, accelTau: 0.27, grip: 0.92 },
  hatchback: { maxSpeed: 21, reverseMax: 8, turnRate: 2.6, accelTau: 0.26, grip: 0.92 },
  'police-sedan': { maxSpeed: 24, reverseMax: 9, turnRate: 2.6, accelTau: 0.25, grip: 0.92 },
  suv: { maxSpeed: 20, reverseMax: 8, turnRate: 2.3, accelTau: 0.30, grip: 0.90 },
  pickup: { maxSpeed: 20, reverseMax: 8, turnRate: 2.3, accelTau: 0.30, grip: 0.90 },
  'police-suv': { maxSpeed: 22, reverseMax: 8.5, turnRate: 2.4, accelTau: 0.28, grip: 0.90 },
  van: { maxSpeed: 19, reverseMax: 7.5, turnRate: 2.2, accelTau: 0.32, grip: 0.90 },
  ambulance: { maxSpeed: 19, reverseMax: 7.5, turnRate: 2.2, accelTau: 0.32, grip: 0.90 },
  bus: { maxSpeed: 16, reverseMax: 6, turnRate: 1.9, accelTau: 0.38, grip: 0.94 },
  firetruck: { maxSpeed: 16, reverseMax: 6, turnRate: 1.9, accelTau: 0.38, grip: 0.94 },
  truck: { maxSpeed: 18, reverseMax: 6.5, turnRate: 2.0, accelTau: 0.35, grip: 0.94 },
  'truck-with-trailer': { maxSpeed: 15, reverseMax: 5.5, turnRate: 1.8, accelTau: 0.40, grip: 0.94 },
  limousine: { maxSpeed: 21, reverseMax: 7.5, turnRate: 2.1, accelTau: 0.33, grip: 0.90 },
  'monster-truck': { maxSpeed: 22, reverseMax: 8.5, turnRate: 2.5, accelTau: 0.27, grip: 0.87 },
}

export const getCarTuning = (id) => {
  const key = id ? id.toLowerCase() : 'sedan'
  return CAR_TUNING[key] || { maxSpeed: CAR_MAX_SPEED, reverseMax: CAR_REVERSE_MAX, turnRate: CAR_TURN_RATE, accelTau: 0.35, grip: 0.90 }
}