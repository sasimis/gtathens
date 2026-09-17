// Audio singleton — the same shape as crashManager: module-level state,
// mutated in place, imported by any system that needs to make noise.
//
// TWO buses, two libraries, deliberately split:
//   2D/UI  -> howler.js  (fire, reload, pickup, door, wheel, crash, footsteps)
//   3D     -> THREE.PositionalAudio on ONE shared AudioListener
//             (drei's <PositionalAudio> builds its own listener PER INSTANCE —
//             6 engine loops would stack 6 listeners on the camera. Here the
//             listener is created once and every node shares its context.)
//
// Callers never touch THREE/Howler directly:
//   audio.play('pickup')                    // 2D one-shot
//   audio.engineUpdate(i, x, y, z, s, on)   // per frame, from ONE useFrame
//   audio.step(gait)                        // footstep, rate follows gait
//
// Autoplay: browsers block audio until a user gesture. AudioSystem resumes
// both contexts on the first pointerdown/keydown (the PLAY click covers it).
// No per-frame allocation: engineUpdate writes into preallocated objects.
import { Howl, Howler } from 'howler'
import * as THREE from 'three'

const master = { v: 1 }

/* ---------------- 2D bus ---------------- */
const sfx = {}
const TWO_D = {
  gunshot: 0.5,
  shoot: 0.5, // alias of gunshot (WeaponController plays 'shoot')
  melee: 0.5, // falls back to gunshot buffer at a lower rate
  reload: 0.5,
  hit: 0.4,
  pickup: 0.4,
  'pickup-money': 0.4, // alias of pickup (brighter rate at play time)
  door: 0.5,
  horn: 0.5, // city traffic horn one-shot (synthesized, see gen-sounds)
  wheel: 0.35,
  footstep: 0.35,
  'footstep-asphalt': 0.35, // alias of footstep (surface variation via rate)
  'footstep-grass': 0.32, // alias of footstep (softer rate at play time)
  screech: 0.4, // synth fallback when /sounds/screech.wav is missing
  crash: 0.6,
  ambient: 0.22, // real file (day bed); night bed is city-hum.wav
  'city-day': 0.2, // alias of ambient (day bed, crossfaded by timeOfDay)
  'city-night': 0.2, // alias of city-hum (night bed, crossfaded by timeOfDay)
}
// Alias map: name -> { base, rate } so `play('shoot')` reuses the gunshot
// buffer instead of 404ing. Missing FILES never break: preload + play both
// fail soft and the game stays silent for that cue.
const ALIAS = {
  shoot: { base: 'gunshot', rate: 1 },
  melee: { base: 'gunshot', rate: 0.45 },
  'pickup-money': { base: 'pickup', rate: 1.35 },
  'footstep-asphalt': { base: 'footstep', rate: 1.05 },
  'footstep-grass': { base: 'footstep', rate: 0.75 },
  'city-day': { base: 'ambient', rate: 1 },
  'city-night': { base: 'city-hum', rate: 0.85 },
}
const resolveHowl = (name) => {
  if (sfx[name]) return { h: sfx[name], rate: 1 }
  const a = ALIAS[name]
  if (a && sfx[a.base]) return { h: sfx[a.base], rate: a.rate }
  return null
}
let loaded2D = false
export const load2D = () => {
  if (loaded2D) return
  loaded2D = true
  // Only fetch files that EXIST in public/sounds (plus the optional screech
  // layer — a 404 there falls back to the synthesized noise, see below).
  const FILES = new Set([
    'gunshot', 'reload', 'hit', 'pickup', 'door', 'horn',
    'footstep', 'crash', 'ambient', 'city-hum', 'screech',
  ])
  const seen = new Set()
  for (const name of Object.keys(TWO_D)) {
    const base = ALIAS[name] ? ALIAS[name].base : name
    if (seen.has(base) || !FILES.has(base)) continue
    seen.add(base)
    sfx[base] = new Howl({ src: [`/sounds/${base}.wav`], volume: TWO_D[base] ?? TWO_D[name], preload: true })
  }
}

/**
 * A 2D one-shot by name. Two forms:
 *   play(name, rate=1, volScale=1)          — plain 2D one-shot
 *   play(name, {x, z, volume})              — positional: fades with distance
 *     from the camera XZ (setListenerXZ) and culled past CULL_M.
 */
export const play2D = (name, rate = 1, volScale = 1) => {
  const r = resolveHowl(name)
  if (!r) return
  let vScale = volScale
  let pitch = rate
  if (rate && typeof rate === 'object') {
    const opts = rate
    const cx = camScratch.x
    const cz = camScratch.z
    if (Number.isFinite(opts.x) && Number.isFinite(opts.z) && (cx !== 0 || cz !== 0)) {
      const d = Math.hypot(opts.x - cx, opts.z - cz)
      if (d > CULL_M) return
      vScale = (opts.volume ?? 1) * Math.max(0, 1 - d / CULL_M)
    } else {
      vScale = opts.volume ?? 1
    }
    pitch = 1
  }
  const id = r.h.play()
  r.h.rate(pitch * r.rate, id)
  r.h.volume(r.h.volume() * vScale, id) // Howler's per-play volume is absolute; scale from the base
}

// Cull radius (m) for positional one-shots — mirrors the building chunking.
const CULL_M = 260
// Camera XZ scratch, written by AudioSystem's useFrame (listener position).
// Lets positional 2D one-shots cull by distance with zero allocation.
const camScratch = { x: 0, z: 0 }
export const setListenerXZ = (x, z) => {
  camScratch.x = x
  camScratch.z = z
}

/** Surface-aware footstep: asphalt cracks, grass thuds (rate + volume). */
export const stepSurface = (onAsphalt) =>
  play2D(onAsphalt ? 'footstep-asphalt' : 'footstep-grass', 0.9 + Math.random() * 0.25, onAsphalt ? 1 : 0.8)

/* ---------------- 3D bus ---------------- */
// The AudioListener (and its AudioContext) are created lazily on the first
// user gesture via getListener().  Creating it at module scope would make
// Chrome's autoplay policy log "The AudioContext was not allowed to start"
// and suspend the context before resume() ever runs.
let listener = null
export const getListener = () => {
  if (!listener) listener = new THREE.AudioListener()
  return listener
}

const POOL = {
  ready: false,
  buffers: {},
  engines: [], // {obj, sound, active, speed} — fixed max, reused every frame
  hums: [],    // static city-hum emitters
}
const ENGINE_MAX = 6 // 1 driven + 5 AI traffic

const fetchBuffer = async (ctx, name) => {
  const res = await fetch(`/sounds/${name}.wav`)
  const ab = await res.arrayBuffer()
  return ctx.decodeAudioData(ab)
}

/**
 * Builds the positional nodes under `scene` (they are plain Object3Ds whose
 * world position the renderer feeds to the panner). Idempotent + fail-soft:
 * if fetch/decode throws, POOL.ready stays false and everything 2D still works.
 */
export const initPositional = async (scene) => {
  if (POOL.ready || POOL.failed) return
  try {
    const ctx = getListener().context
    const [engine, hum] = await Promise.all([fetchBuffer(ctx, 'engine-loop'), fetchBuffer(ctx, 'city-hum')])
    POOL.buffers.engine = engine
    POOL.buffers.hum = hum
    for (let i = 0; i < ENGINE_MAX; i += 1) {
      const obj = new THREE.Object3D()
      scene.add(obj)
      const sound = new THREE.PositionalAudio(getListener())
      sound.setBuffer(engine)
      sound.setLoop(true)
      sound.setRefDistance(14)
      sound.setVolume(0)
      obj.add(sound)
      POOL.engines.push({ obj, sound, active: false, speed: 0 })
    }
    // Four static ambience spots (spawn-relative quadrants) over one 2D bed.
    for (const [dx, dz] of [[150, 150], [-150, 150], [150, -150], [-150, -150]]) {
      const obj = new THREE.Object3D()
      obj.position.set(dx, 2, dz)
      scene.add(obj)
      const sound = new THREE.PositionalAudio(getListener())
      sound.setBuffer(hum)
      sound.setLoop(true)
      sound.setRefDistance(60)
      sound.setVolume(0.3 * master.v)
      obj.add(sound)
      sound.play()
      POOL.hums.push({ obj, sound })
    }
    POOL.ready = true
  } catch (e) {
    POOL.failed = true
    console.warn('audio: positional bus unavailable', e)
  }
}

const ENGINE_BASE = 0.55

const GEAR_SPEEDS = [0, 15, 35, 60, 85, 120] // km/h thresholds for gears 1..5

const CAR_AUDIO_PROFILES = {
  sports: { pitchMult: 1.22, idleRpm: 1000, maxRpm: 7200 },
  roadster: { pitchMult: 1.22, idleRpm: 1000, maxRpm: 7200 },
  'police-sports': { pitchMult: 1.22, idleRpm: 1000, maxRpm: 7200 },
  muscle: { pitchMult: 1.15, idleRpm: 950, maxRpm: 6500 },
  'muscle-2': { pitchMult: 1.15, idleRpm: 950, maxRpm: 6500 },
  'police-muscle': { pitchMult: 1.15, idleRpm: 950, maxRpm: 6500 },
  sedan: { pitchMult: 1.0, idleRpm: 850, maxRpm: 5800 },
  taxi: { pitchMult: 1.0, idleRpm: 850, maxRpm: 5800 },
  hatchback: { pitchMult: 1.05, idleRpm: 880, maxRpm: 6000 },
  'police-sedan': { pitchMult: 1.08, idleRpm: 900, maxRpm: 6200 },
  suv: { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
  pickup: { pitchMult: 0.90, idleRpm: 800, maxRpm: 5200 },
  'police-suv': { pitchMult: 0.95, idleRpm: 820, maxRpm: 5500 },
  van: { pitchMult: 0.85, idleRpm: 750, maxRpm: 4800 },
  ambulance: { pitchMult: 0.85, idleRpm: 750, maxRpm: 4800 },
  bus: { pitchMult: 0.70, idleRpm: 700, maxRpm: 3800 },
  firetruck: { pitchMult: 0.68, idleRpm: 700, maxRpm: 3600 },
  truck: { pitchMult: 0.72, idleRpm: 720, maxRpm: 4000 },
  'truck-with-trailer': { pitchMult: 0.65, idleRpm: 680, maxRpm: 3500 },
  limousine: { pitchMult: 0.95, idleRpm: 800, maxRpm: 5200 },
  'monster-truck': { pitchMult: 0.88, idleRpm: 850, maxRpm: 5000 },
}

const calculateEngineRpm = (speedKmh, carClass = 'sedan') => {
  const profile = CAR_AUDIO_PROFILES[carClass ? carClass.toLowerCase() : 'sedan'] || CAR_AUDIO_PROFILES.sedan
  const absSpeed = Math.abs(speedKmh)

  let gear = 1
  for (let i = 1; i < GEAR_SPEEDS.length - 1; i += 1) {
    if (absSpeed >= GEAR_SPEEDS[i]) gear = i + 1
  }

  const gMin = GEAR_SPEEDS[gear - 1]
  const gMax = GEAR_SPEEDS[gear]
  const progress = Math.max(0, Math.min(1, (absSpeed - gMin) / (gMax - gMin)))

  const minRpm = gear === 1 ? profile.idleRpm : profile.idleRpm * 1.8
  const maxRpm = profile.maxRpm
  const rpm = minRpm + progress * (maxRpm - minRpm)

  return { rpm, gear, progress, profile }
}

/** Per-frame engine write: position + pitch + on/off with gear RPM simulation. */
export const engineUpdate = (i, x, y, z, speed01, active, carClass = 'sedan', load = 0) => {
  const e = POOL.engines[i]
  if (!e || !POOL.ready) return
  e.obj.position.set(x, y, z)
  e.active = active

  if (e.smoothRate === undefined) e.smoothRate = 0.8
  if (e.smoothVol === undefined) e.smoothVol = 0.0

  if (!active) {
    e.smoothVol += (0 - e.smoothVol) * 0.2
    e.sound.setVolume(e.smoothVol)
    if (e.smoothVol < 0.005 && e.sound.isPlaying) {
      try { e.sound.pause() } catch {}
    }
    return
  }

  const speedKmh = Math.max(0, Math.min(1, speed01)) * 100
  const { rpm, profile } = calculateEngineRpm(speedKmh, carClass)

  let baseRate = (0.70 + (rpm / 6000) * 0.85) * profile.pitchMult
  if (load > 0.1) baseRate *= 1.04
  else if (load < -0.1) baseRate *= 0.97

  const targetVol = ENGINE_BASE * (0.4 + 0.6 * Math.min(1, speed01 * 1.2 + Math.abs(load) * 0.2)) * master.v
  e.smoothRate += (baseRate - e.smoothRate) * 0.18
  e.smoothVol += (targetVol - e.smoothVol) * 0.18

  e.sound.setVolume(e.smoothVol)
  e.sound.setPlaybackRate(e.smoothRate)

  if (!e.sound.isPlaying) {
    try { e.sound.play() } catch {}
  }
}

// --- Tire screech: synth fallback (no asset in public/sounds) -------------
// A short band-passed noise burst through the WebAudio context Howler owns.
// Fail-soft: if the context is missing, this is a silent no-op.
let screechBuf = null
const screechState = { lastAt: 0 }
export const screech = (intensity = 1) => {
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (now - screechState.lastAt < 180) return // gate: bursts, not a drone
  screechState.lastAt = now
  // Prefer the real asset when present; otherwise synthesize.
  const r = sfx.screech && sfx.screech.state && (() => { try { return sfx.screech.state() === 'loaded' } catch { return false } })()
  if (r) {
    const id = sfx.screech.play()
    sfx.screech.rate(0.9 + Math.random() * 0.2, id)
    sfx.screech.volume(sfx.screech.volume() * Math.max(0, Math.min(1, intensity)), id)
    return
  }
  try {
    const ctx = Howler.ctx
    if (!ctx || ctx.state !== 'running') return
    if (!screechBuf) {
      const len = Math.floor(ctx.sampleRate * 0.25)
      screechBuf = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = screechBuf.getChannelData(0)
      for (let k = 0; k < len; k += 1) d[k] = (Math.random() * 2 - 1) * (1 - k / len)
    }
    const src = ctx.createBufferSource()
    src.buffer = screechBuf
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 900 + Math.random() * 600
    bp.Q.value = 2.5
    const g = ctx.createGain()
    const v = 0.12 * Math.max(0, Math.min(1, intensity)) * master.v
    g.gain.setValueAtTime(v, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
    src.connect(bp)
    bp.connect(g)
    g.connect(ctx.destination)
    src.start()
  } catch { /* silent */ }
}

// Occasional distant traffic horn from the AI stream (called ~4 Hz from
// AudioSystem with the live AI count; rate-limited + culled in play2D).
// Zero allocation: module-level timer only.
let lastHornAt = 0
export const trafficHorn = (nearCount = 0) => {
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (now - lastHornAt < 9000) return
  lastHornAt = now
  // busier streets honk more often — 8% base, +6% per AI car in earshot
  if (Math.random() > 0.08 + Math.min(0.4, nearCount * 0.06)) return
  play2D('horn', 0.85 + Math.random() * 0.3, 0.25)
}

// --- Day/night city beds: crossfade by timeOfDay --------------------------
const beds = { dayId: null, nightId: null, dayVol: 0, nightVol: 0 }
/**
 * Crossfade the two ambient beds by hour (0-24). Day bed (ambient.wav) peaks
 * at noon, night bed (city-hum.wav) peaks at midnight — two REAL files, so
 * the "city sounds remain the same" flat-bed bug (both voices on one buffer)
 * cannot regress. Call throttled (~4 Hz is plenty).
 */
export const bedsUpdate = (hour) => {
  const day = sfx.ambient
  const night = sfx['city-hum'] || sfx.ambient
  if (!day || !loaded2D) return
  const h = ((hour % 24) + 24) % 24
  // Night weight: full at 0h, zero 8h-17h, ramps at dawn/dusk.
  let nightW = 0
  if (h < 5 || h >= 20) nightW = 1
  else if (h < 8) nightW = 1 - (h - 5) / 3
  else if (h >= 17) nightW = (h - 17) / 3
  const dayW = 1 - nightW
  try {
    if (beds.dayId == null) {
      beds.dayId = day.play()
      day.rate(1, beds.dayId)
      day.loop(true, beds.dayId)
    }
    if (beds.nightId == null) {
      beds.nightId = night.play()
      night.rate(0.85, beds.nightId)
      night.loop(true, beds.nightId)
    }
    const base = 0.22 * master.v
    const dVol = base * (0.25 + 0.75 * dayW)
    const nVol = base * (0.25 + 0.75 * nightW)
    if (Math.abs(dVol - beds.dayVol) > 0.005) {
      beds.dayVol = dVol
      day.volume(dVol, beds.dayId)
    }
    if (Math.abs(nVol - beds.nightVol) > 0.005) {
      beds.nightVol = nVol
      night.volume(nVol, beds.nightId)
    }
  } catch { /* ignore */ }
}

/* ---------------- API ---------------- */
export const audio = {
  /** Resume after a user gesture (autoplay policy). Creates the AudioListener
   *  (THREE AudioContext) and Howl objects (Howler AudioContext) on first call
   *  so neither context is instantiated before the gesture. Safe to call
   *  repeatedly. */
  resume: () => {
    // First user gesture: create both contexts + load Howl objects.
    load2D()
    const l = getListener()
    try { Howler.ctx && Howler.ctx.state !== 'running' && Howler.ctx.resume() } catch (e) { /* ignore */ }
    try { l.context.state !== 'running' && l.context.resume() } catch (e) { /* ignore */ }
  },
  setMasterVolume: (v) => {
    master.v = Math.max(0, Math.min(1, v))
    try { Howler.volume(master.v) } catch (e) { /* ignore */ }
    for (const h of POOL.hums) h.sound.setVolume(0.3 * master.v)
  },
  /** One 2D ambience bed (city hum), started on first PLAY. */
  startAmbient: () => {
    const h = sfx.ambient
    if (h && !h.playing()) {
      try {
        const id = h.play()
        h.loop(true, id)
        beds.dayId = id // bedsUpdate() crossfades from this voice
      } catch { /* ignore */ }
    }
  },
  /** Positional form: store.audio.play(name, {x, z, volume}) — culled past 260 m. */
  play: play2D,
  /** Footstep: slight rate jitter so repeated hits don't sound robotic. */
  step: () => play2D('footstep', 0.85 + Math.random() * 0.3),
  /** Surface-aware footstep: asphalt cracks, grass thuds. */
  stepSurface,
  /** Tire screech burst (drift > 15 deg + speed). */
  screech,
  /** Occasional distant traffic horn (AI stream ambience). */
  horn: trafficHorn,
  /** Day/night bed crossfade (call throttled with the game clock). */
  bedsUpdate,
  setListenerXZ,
  crash: (dmg01) => play2D('crash', 0.9 + Math.random() * 0.2, 0.5 + Math.min(1, dmg01) * 0.6),
  engineUpdate,
  initPositional,
  /** QA seam (smoke.mjs): one stable object, mutated in place. */
  qa: {
    ready: () => POOL.ready,
    engines: POOL.engines,
    master,
    howls: () => Object.keys(sfx).length,
  },
}
if (typeof window !== 'undefined') window.__gtathensAudio = audio.qa
