// Audio singleton — module-level state, mutated in place, imported by any system that needs to make noise.
import { Howl, Howler } from 'howler'
import * as THREE from 'three'

const master = { v: 1 }

/* ---------------- 2D bus ---------------- */
const sfx = {}
const TWO_D = {
  gunshot: 0.5,
  shoot: 0.5,
  melee: 0.5,
  reload: 0.5,
  hit: 0.4,
  pickup: 0.4,
  'pickup-money': 0.4,
  door: 0.5,
  horn: 0.5,
  wheel: 0.35,
  footstep: 0.35,
  'footstep-asphalt': 0.35,
  'footstep-grass': 0.32,
  screech: 0.4,
  crash: 0.6,
  ambient: 0.22,
  'city-day': 0.2,
  'city-night': 0.2,
}

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
  r.h.volume(r.h.volume() * vScale, id)
}

const CULL_M = 260
const camScratch = { x: 0, z: 0 }
export const setListenerXZ = (x, z) => {
  camScratch.x = x
  camScratch.z = z
}

/** Surface-aware footstep: asphalt cracks, grass thuds. */
export const stepSurface = (onAsphalt, isRunning = false) => {
  const rate = (onAsphalt ? 1.05 : 0.8) + (Math.random() * 0.2 - 0.1) + (isRunning ? 0.15 : 0)
  const vol = (onAsphalt ? 0.9 : 0.7) * (isRunning ? 1.2 : 0.85)
  play2D(onAsphalt ? 'footstep-asphalt' : 'footstep-grass', rate, vol)
}

/** Jump takeoff sound */
export const jumpSound = () => {
  play2D('footstep', 1.25, 0.9)
}

/** Jump landing thud sound */
export const landSound = (impactVel = 0) => {
  const vol = Math.min(1.4, 0.7 + Math.abs(impactVel) * 0.1)
  play2D('footstep', 0.65, vol)
}

/* ---------------- 3D bus ---------------- */
let listener = null
export const getListener = () => {
  if (!listener) listener = new THREE.AudioListener()
  return listener
}

const POOL = {
  ready: false,
  buffers: {},
  engines: [],
  hums: [],
}
const ENGINE_MAX = 6

const fetchBuffer = async (ctx, name) => {
  const res = await fetch(`/sounds/${name}.wav`)
  const ab = await res.arrayBuffer()
  return ctx.decodeAudioData(ab)
}

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
const GEAR_SPEEDS = [0, 15, 35, 60, 85, 120]

const CAR_AUDIO_PROFILES = {
  sports: { pitchMult: 1.22, idleRpm: 1000, maxRpm: 7200 },
  'sports-yellow': { pitchMult: 1.22, idleRpm: 1000, maxRpm: 7200 },
  'sports-stripe': { pitchMult: 1.22, idleRpm: 1000, maxRpm: 7200 },
  muscle: { pitchMult: 1.15, idleRpm: 950, maxRpm: 6500 },
  'muscle-black': { pitchMult: 1.15, idleRpm: 950, maxRpm: 6500 },
  'muscle-green': { pitchMult: 1.15, idleRpm: 950, maxRpm: 6500 },
  'muscle-teal': { pitchMult: 1.15, idleRpm: 950, maxRpm: 6500 },
  sedan: { pitchMult: 1.0, idleRpm: 850, maxRpm: 5800 },
  'sedan-blue': { pitchMult: 1.0, idleRpm: 850, maxRpm: 5800 },
  'sedan-darkred': { pitchMult: 1.0, idleRpm: 850, maxRpm: 5800 },
  suv: { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
  'suv-black': { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
  'suv-green': { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
  'suv-teal': { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
  'suv-yellow': { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
  'suv-blue': { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
  'suv-orange': { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
  'suv-red': { pitchMult: 0.92, idleRpm: 800, maxRpm: 5400 },
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

let screechBuf = null
const screechState = { lastAt: 0 }
export const screech = (intensity = 1) => {
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (now - screechState.lastAt < 180) return
  screechState.lastAt = now
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

// --- Car explosion: synth boom (no /sounds asset — always available) --------
// A low-passed white-noise body (the blast wave closing from crack to rumble)
// plus a sub sine thump (the chest punch). Same fail-soft contract as screech:
// no running AudioContext = silent no-op, the game never crashes for sound.
let boomNoise = null
export const explosion = (intensity = 1) => {
  try {
    const ctx = Howler.ctx
    if (!ctx || ctx.state !== 'running') return
    const v = Math.max(0, Math.min(1, intensity)) * 0.55 * master.v
    if (v <= 0) return
    const now = ctx.currentTime
    const pitch = 0.9 + Math.random() * 0.25
    if (!boomNoise) {
      const len = Math.floor(ctx.sampleRate * 1.2)
      boomNoise = ctx.createBuffer(1, len, ctx.sampleRate)
      const d = boomNoise.getChannelData(0)
      for (let k = 0; k < len; k += 1) d[k] = (Math.random() * 2 - 1) * (1 - k / len)
    }
    // Blast body: noise through a fast-closing lowpass (bright crack -> rumble).
    const src = ctx.createBufferSource()
    src.buffer = boomNoise
    src.playbackRate.value = pitch
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(2400, now)
    lp.frequency.exponentialRampToValueAtTime(90, now + 0.9)
    lp.Q.value = 0.8
    const g = ctx.createGain()
    g.gain.setValueAtTime(v, now)
    g.gain.exponentialRampToValueAtTime(0.001, now + 1.1)
    src.connect(lp)
    lp.connect(g)
    g.connect(ctx.destination)
    src.start(now)
    src.stop(now + 1.2)
    // Sub thump: 82 -> 30 Hz sine for the punch you feel in your teeth.
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(82 * pitch, now)
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.45)
    const og = ctx.createGain()
    og.gain.setValueAtTime(v * 1.1, now)
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.55)
    osc.connect(og)
    og.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.6)
  } catch { /* silent */ }
}

let lastHornAt = 0
export const trafficHorn = (nearCount = 0) => {
  const now = typeof performance !== 'undefined' ? performance.now() : 0
  if (now - lastHornAt < 9000) return
  lastHornAt = now
  if (Math.random() > 0.08 + Math.min(0.4, nearCount * 0.06)) return
  play2D('horn', 0.85 + Math.random() * 0.3, 0.25)
}

const beds = { dayId: null, nightId: null, dayVol: 0, nightVol: 0 }
export const bedsUpdate = (hour) => {
  const day = sfx.ambient
  const night = sfx['city-hum'] || sfx.ambient
  if (!day || !loaded2D) return
  const h = ((hour % 24) + 24) % 24
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
  resume: () => {
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
  startAmbient: () => {
    const h = sfx.ambient
    if (h && !h.playing()) {
      try {
        const id = h.play()
        h.loop(true, id)
        beds.dayId = id
      } catch { /* ignore */ }
    }
  },
  play: play2D,
  step: () => play2D('footstep', 0.85 + Math.random() * 0.3),
  stepSurface,
  jump: jumpSound,
  land: landSound,
  screech,
  horn: trafficHorn,
  bedsUpdate,
  setListenerXZ,
  crash: (dmg01) => play2D('crash', 0.9 + Math.random() * 0.2, 0.5 + Math.min(1, dmg01) * 0.6),
  /** Car explosion — synth boom, see explosion() above. */
  explosion,
  engineUpdate,
  initPositional,
  qa: {
    ready: () => POOL.ready,
    engines: POOL.engines,
    master,
    howls: () => Object.keys(sfx).length,
  },
}
if (typeof window !== 'undefined') window.__gtathensAudio = audio.qa
