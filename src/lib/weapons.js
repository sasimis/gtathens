// Weapon definitions + procedural low-poly gun models.
// No new assets needed: the guns are built from boxes/cylinders in code, which
// matches the game's low-poly Kenney aesthetic and keeps the bundle asset-free.
// Pure data + pure three.js geometry — safe to import from the store.
import * as THREE from 'three'

// Weapon schema (one JSON-ish object per gun — nothing is hardcoded in the
// firing code). Everything in meters / seconds / radians.
//
//   rpm           rounds per minute — the fire loop derives cooldown = 60/rpm so
//                 the weapon ignores framerate (the old fixed 0.016 s step made
//                 an SMG fire at ~62 rpm on a 60 fps desktop and ~40 rpm in a
//                 throttled tab).
//   reloadTime    seconds to reload (was a shared 1.6 for every gun).
//   range         max hitscan distance (m).
//   damage        per bullet, before the headshot multiplier.
//   headshotMul   damage multiplier for a head hit (2.5 = the brief's number).
//   spread        cone half-angle of the FIRST (settled) shot, radians.
//   spreadGain    radians of cone added per shot while the trigger is held.
//   spreadMax     cone ceiling; crosshair[data-bloom] normalizes against it.
//   recoil        radians of vertical muzzle climb per shot (pattern scales it).
//   recoilPattern per-shot {x, y} kick multipliers — the classic spray shape.
//   shake         0..1 camera-shake amplitude per shot.
//   recoilKick    metres the gun mesh pushes back (Jolt), for the gun IK.
//   pellets       bullets per trigger pull (shotgun).
//   knockback     metres/second of impulse applied to a ped that is hit.
//   auto          hold-to-fire.
//   melee         fists: no ray, proximity swing.
//   pickupAmmo    rounds granted by a ground pickup.
export const WEAPONS = {
  fists: {
    id: 'fists',
    name: 'Fists',
    melee: true,
    damage: 15,
    range: 2.2, // world meters, measured from the player body
    cooldown: 0.45,
    mag: 0,
    spread: 0,
    spreadGain: 0,
    spreadMax: 0,
    recoil: 0,
    headshotMul: 1,
    shake: 0.06,
    knockback: 1.4,
  },
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    melee: false,
    damage: 34,
    headshotMul: 2.5,
    range: 70,
    rpm: 420,
    cooldown: 60 / 420, // kept for the store/UI which read cooldown directly
    mag: 12,
    reloadTime: 1.35,
    spread: 0.012, // first shot is nearly true
    spreadGain: 0.012,
    spreadMax: 0.07,
    recoil: 0.016,
    recoilPattern: [
      { x: 0, y: 1 }, { x: 0.25, y: 1.15 }, { x: -0.3, y: 1.1 },
      { x: 0.4, y: 0.95 }, { x: -0.45, y: 0.9 }, { x: 0.5, y: 0.8 },
    ],
    shake: 0.1,
    recoilKick: 0.035,
    knockback: 1.2,
    auto: false,
    pickupAmmo: 24,
  },
  smg: {
    id: 'smg',
    name: 'SMG',
    melee: false,
    damage: 15,
    headshotMul: 2.5,
    range: 55,
    rpm: 750,
    cooldown: 60 / 750,
    mag: 30,
    reloadTime: 1.8,
    spread: 0.02,
    spreadGain: 0.016, // blooms fast and stays wide — must be tapped
    spreadMax: 0.085,
    recoil: 0.009,
    recoilPattern: [
      { x: 0, y: 1 }, { x: 0.15, y: 1.2 }, { x: -0.2, y: 1.3 },
      { x: 0.3, y: 1.2 }, { x: -0.35, y: 1.15 }, { x: 0.45, y: 1.1 },
      { x: -0.5, y: 1.05 }, { x: 0.55, y: 1.0 }, { x: -0.6, y: 0.95 },
    ],
    shake: 0.12,
    recoilKick: 0.03,
    knockback: 0.8,
    auto: true,
    pickupAmmo: 60,
  },
  rifle: {
    id: 'rifle',
    name: 'Rifle',
    melee: false,
    damage: 30,
    headshotMul: 2.5,
    range: 95,
    rpm: 420,
    cooldown: 60 / 420,
    mag: 20,
    reloadTime: 2.0,
    spread: 0.014,
    spreadGain: 0.01,
    spreadMax: 0.06,
    recoil: 0.019,
    recoilPattern: [
      { x: 0, y: 1 }, { x: -0.2, y: 1.2 }, { x: 0.3, y: 1.2 },
      { x: -0.4, y: 1.1 }, { x: 0.45, y: 1.05 }, { x: -0.5, y: 1.0 },
    ],
    shake: 0.16,
    recoilKick: 0.05,
    knockback: 1.6,
    auto: false,
    pickupAmmo: 60,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    melee: false,
    damage: 13, // per pellet — 8 pellets land ~104 up close
    headshotMul: 1.6, // pellets make headshots cheap already
    pellets: 8,
    range: 38,
    rpm: 75,
    cooldown: 60 / 75,
    mag: 8,
    reloadTime: 2.4,
    spread: 0.055,
    spreadGain: 0,
    spreadMax: 0.055,
    recoil: 0.05, // big kick — the brief's 0.4 shake tier
    recoilPattern: [{ x: 0, y: 1 }, { x: 0.1, y: 1.1 }, { x: -0.1, y: 1.05 }],
    shake: 0.4,
    recoilKick: 0.09,
    knockback: 3.2,
    auto: false,
    pickupAmmo: 24,
  },
  revolver: {
    id: 'revolver',
    name: 'Revolver',
    melee: false,
    damage: 46,
    headshotMul: 2.5,
    range: 60,
    rpm: 150,
    cooldown: 60 / 150,
    mag: 6,
    reloadTime: 2.1,
    spread: 0.016,
    spreadGain: 0.02,
    spreadMax: 0.09,
    recoil: 0.042,
    recoilPattern: [{ x: 0, y: 1 }, { x: 0.2, y: 1.15 }, { x: -0.25, y: 1.1 }],
    shake: 0.3,
    recoilKick: 0.075,
    knockback: 2.4,
    auto: false,
    pickupAmmo: 18,
  },
  marksman: {
    id: 'marksman',
    name: 'Marksman',
    melee: false,
    damage: 62,
    headshotMul: 3, // the precision reward
    range: 140,
    rpm: 55,
    cooldown: 60 / 55,
    mag: 5,
    reloadTime: 2.6,
    spread: 0.004, // laser when standing still
    spreadGain: 0.02,
    spreadMax: 0.07,
    recoil: 0.036,
    recoilPattern: [{ x: 0, y: 1 }, { x: 0.15, y: 1.1 }, { x: -0.15, y: 1.05 }],
    shake: 0.26,
    recoilKick: 0.07,
    knockback: 3,
    auto: false,
    pickupAmmo: 20,
  },
}

// Includes 'fists' — the cycle order walks everything the player can hold.
export const WEAPON_ORDER = [
  'fists',
  'pistol',
  'revolver',
  'smg',
  'rifle',
  'shotgun',
  'marksman',
]

// NPC health / bounty tuning shared by the shooting + NPC systems.
export const NPC_HP = 40
export const NPC_CASH_MIN = 12
export const NPC_CASH_MAX = 55

// Shared fire FX state (mutated in place by the shooting controller, consumed
// by the gun mount + the bullet-fx renderer). Zero allocation per frame.
export const gunFX = {
  // 0..1 gun/arm kick. Mirrored from lib/combat.js#combat.recoil so the model
  // layer (Protagonist's additive arm pose) can read it without importing the
  // combat module — the mount still owns the mesh kick below.
  recoil: 0,
  // Metres the gun mesh is pushed back along its own -Z per kick, copied from
  // the equipped weapon's `recoilKick` by <GunMount>.
  kick: 0.04,
  // True while the player is holding a gun (mount publishes it).
  held: false,
  // Returns the current muzzle world position into `out` (or null before the
  // gun exists). Installed by <GunMount> while a gun is mounted.
  getMuzzle: null,
}

// ---------------------------------------------------------------------------
// Procedural gun models. Both point +Z (the character's forward), grip down,
// sized in meters. A child Object3D named 'muzzle' marks the barrel tip.
// ---------------------------------------------------------------------------

const MESH_DARK = 0x23262e
const MESH_GRIP = 0x17191f
const MESH_ACCENT = 0xf5b800
const MESH_STEEL = 0x3a3f4b

const box = (w, h, d, color, x = 0, y = 0, z = 0, rx = 0) => {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.35 }),
  )
  m.position.set(x, y, z)
  m.rotation.x = rx
  m.castShadow = true
  return m
}

const cylinder = (r, len, color, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, len, 8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.55 }),
  )
  m.rotation.x = Math.PI / 2 // align along Z
  m.position.set(x, y, z)
  m.castShadow = true
  return m
}

/** Builds the low-poly gun model for `id`; returns a fresh THREE.Group. */
export const buildGunModel = (id) => {
  const g = new THREE.Group()
  if (id === 'smg') {
    // Receiver + barrel + stock + magazine + grip.
    g.add(box(0.052, 0.075, 0.34, MESH_DARK, 0, 0.02, 0.02))
    g.add(cylinder(0.013, 0.16, MESH_STEEL, 0, 0.03, 0.26))
    g.add(box(0.03, 0.028, 0.1, MESH_ACCENT, 0, 0.03, 0.18)) // top rail
    g.add(box(0.04, 0.055, 0.14, MESH_DARK, 0, 0.015, -0.18)) // stock
    g.add(box(0.036, 0.17, 0.05, MESH_GRIP, 0, -0.09, 0.03, 0.12)) // magazine
    g.add(box(0.034, 0.1, 0.045, MESH_GRIP, 0, -0.065, -0.09, -0.3)) // grip
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.03, 0.34)
    g.add(muzzle)
  } else if (id === 'rifle') {
    // Longer receiver, detachable box magazine, mid-length barrel, foregrip.
    g.add(box(0.054, 0.072, 0.46, MESH_DARK, 0, 0.02, 0.02))
    g.add(cylinder(0.014, 0.22, MESH_STEEL, 0, 0.03, 0.34))
    g.add(box(0.03, 0.028, 0.12, MESH_ACCENT, 0, 0.03, 0.24)) // top rail
    g.add(box(0.042, 0.055, 0.16, MESH_DARK, 0, 0.015, -0.22)) // stock
    g.add(box(0.036, 0.17, 0.05, MESH_GRIP, 0, -0.09, 0.04, 0.12)) // magazine
    g.add(box(0.036, 0.1, 0.05, MESH_GRIP, 0.04, -0.055, 0.02, -0.28)) // foregrip
    g.add(box(0.034, 0.1, 0.045, MESH_GRIP, 0, -0.065, -0.1, -0.3)) // grip
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.03, 0.46)
    g.add(muzzle)
  } else if (id === 'shotgun') {
    // Pump-action: long barrel, rib, extended magazine tube, chunky grip.
    g.add(box(0.06, 0.08, 0.42, MESH_DARK, 0, 0.025, 0.02))
    g.add(cylinder(0.018, 0.26, MESH_STEEL, 0, 0.035, 0.3))
    g.add(box(0.026, 0.024, 0.18, MESH_STEEL, 0, 0.05, 0.2)) // barrel rib
    g.add(box(0.042, 0.06, 0.2, MESH_DARK, 0, 0.015, -0.22)) // stock
    g.add(box(0.042, 0.18, 0.05, MESH_GRIP, 0, -0.085, 0.05, 0.1)) // tube mag
    g.add(box(0.04, 0.11, 0.052, MESH_GRIP, 0, -0.07, -0.1, -0.26)) // grip
    g.add(box(0.032, 0.02, 0.04, MESH_ACCENT, 0, 0.06, -0.02)) // forend accent
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.035, 0.42)
    g.add(muzzle)
  } else if (id === 'revolver') {
    // Heavy swing-out frame, cylinder bulge, short barrel, pistol grip.
    g.add(box(0.05, 0.064, 0.22, MESH_DARK, 0, 0.03, 0.03))
    g.add(box(0.044, 0.046, 0.18, MESH_STEEL, 0, 0.006, 0.045))
    g.add(box(0.06, 0.05, 0.05, MESH_DARK, 0, 0.06, 0.12)) // cylinder
    g.add(cylinder(0.016, 0.1, MESH_STEEL, 0, 0.03, 0.22))
    g.add(box(0.042, 0.14, 0.06, MESH_GRIP, 0, -0.055, -0.06, -0.28)) // grip
    g.add(box(0.032, 0.02, 0.04, MESH_ACCENT, 0, 0.05, -0.01)) // sight block
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.03, 0.22)
    g.add(muzzle)
  } else if (id === 'marksman') {
    // Bolt-action silhouette: long barrel, straight-pull stock, flat receiver.
    g.add(box(0.046, 0.066, 0.52, MESH_DARK, 0, 0.02, 0.02))
    g.add(cylinder(0.012, 0.32, MESH_STEEL, 0, 0.028, 0.4))
    g.add(box(0.028, 0.026, 0.14, MESH_ACCENT, 0, 0.03, 0.28)) // top rail
    g.add(box(0.038, 0.05, 0.16, MESH_DARK, 0, 0.016, -0.24)) // stock
    g.add(box(0.032, 0.09, 0.044, MESH_GRIP, 0.03, -0.05, 0.04, -0.26)) // foregrip
    g.add(box(0.03, 0.085, 0.04, MESH_GRIP, 0, -0.05, -0.12, -0.3)) // grip
    g.add(box(0.02, 0.02, 0.06, MESH_STEEL, 0, 0.04, 0.12)) // bolt handle
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.028, 0.52)
    g.add(muzzle)
  } else {
    // Pistol: slide + frame + grip.
    g.add(box(0.046, 0.052, 0.2, MESH_DARK, 0, 0.028, 0.03))
    g.add(box(0.04, 0.03, 0.15, MESH_STEEL, 0, 0.005, 0.045))
    g.add(box(0.038, 0.12, 0.052, MESH_GRIP, 0, -0.05, -0.055, -0.24))
    g.add(box(0.034, 0.02, 0.05, MESH_ACCENT, 0, 0.058, -0.02)) // rear sight block
    const muzzle = new THREE.Object3D()
    muzzle.name = 'muzzle'
    muzzle.position.set(0, 0.03, 0.14)
    g.add(muzzle)
  }
  return g
}