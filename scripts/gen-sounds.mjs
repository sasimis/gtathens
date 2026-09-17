// Sound asset synthesizer — writes 16-bit PCM WAVs into public/sounds/.
// No network, no deps: the game is asset-free low-poly, so the audio pack is
// synthesized to match (Kenney-style blips, engine rumble, gunshots). Run:
//   node scripts/gen-sounds.mjs
// Every "loop" file is seamless: the tail is crossfaded into the head.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 44100
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds')
mkdirSync(outDir, { recursive: true })

const TAU = Math.PI * 2
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/** 16-bit mono WAV writer. */
const writeWav = (name, samples) => {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i += 1) {
    const v = clamp(samples[i], -1, 1)
    buf.writeInt16LE((v < 0 ? v * 0x8000 : v * 0x7fff) | 0, 44 + i * 2)
  }
  writeFileSync(path.join(outDir, name), buf)
  console.log(`${name}: ${(n / SR).toFixed(2)}s`)
}

const secs = (s) => Math.round(s * SR)
/** One-pole lowpass over x with coefficient a (a near 1 = darker). */
const lowpass = (x, a, s = { y: 0 }) => { s.y += a * (x - s.y); return s.y }
/** Crossfade the last `fade` samples into the head -> seamless loop. */
const makeLoop = (x, fadeSec) => {
  const f = secs(fadeSec)
  const n = x.length - f
  const out = new Float64Array(n)
  for (let i = 0; i < n; i += 1) {
    if (i < n - f) out[i] = x[i]
    else {
      const w = (i - (n - f)) / f // 0 -> 1 across the fade
      out[i] = x[i] * (1 - w) + x[n + i] * w
    }
  }
  return out
}
const norm = (x, peak = 0.9) => {
  let m = 0
  for (const v of x) m = Math.max(m, Math.abs(v))
  if (m < 1e-9) return x
  const g = peak / m
  for (let i = 0; i < x.length; i += 1) x[i] *= g
  return x
}
let seed = 12345
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff - 0.5
}

// --- engine loop: 55 Hz-ish rumble (integer-period tones) + dark noise -----
{
  const N = 800 // 55.125 Hz fundamental -> integer cycles in N samples
  const n = secs(1.4)
  const x = new Float64Array(n)
  let ns = { y: 0 }
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    const saw = 2 * ((i % N) / N) - 1 // raw saw @ 55.125 Hz
    const body = saw * 0.5 + Math.sin((TAU * i) / (N / 2)) * 0.22 + Math.sin((TAU * i) / (N / 4)) * 0.08
    const rumble = lowpass(rnd() * 2, 0.12, ns) * 0.5
    // slow idle wobble so a looping idle doesn't sound like a pure tone
    const wob = 1 + 0.06 * Math.sin(TAU * 3.1 * t)
    x[i] = (body * 0.8 + rumble) * wob
  }
  writeWav('engine-loop.wav', norm(makeLoop(x, 0.02)))
}

// --- city hum: dark brown-ish noise bed + faint mains hum, 5 s loop --------
// (kept as the NIGHT layer; the brighter day bed is ambient.wav below)
{
  const n = secs(5)
  const x = new Float64Array(n)
  let ns = { y: 0 }, br = { y: 0 }
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    let v = lowpass(rnd() * 2, 0.045, ns) * 2.2
    v += lowpass(v, 0.01, br) * 6
    v += Math.sin((TAU * i) / 400) * 0.35 // 110.25 Hz tone, integer period
    v *= 1 + 0.15 * Math.sin(TAU * 0.37 * t)
    x[i] = v
  }
  writeWav('city-hum.wav', norm(makeLoop(x, 0.06), 0.85))
}

// --- ambient city bed (public/sounds/ambient.wav): breeze + distant --------
// --- traffic. Brighter than the night hum so the day/night crossfade has
// --- somewhere to go (both ride on real files now, no aliasing).
{
  const n = secs(6)
  const x = new Float64Array(n)
  let ns = { y: 0 }, br = { y: 0 }, lp = { y: 0 }
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    // airy breeze: slow-swelling filtered noise
    const breeze = lowpass(rnd() * 2, 0.09, ns) * (1.6 + 0.9 * Math.sin(TAU * 0.23 * t))
    // distant traffic: very low brown rumble with slow swells
    const rumble = lowpass(lowpass(rnd() * 2, 0.05, lp), 0.02, br) * 5
    // sparse distant horns: two soft sine pips per loop, heavily faded
    const hornT = (t % 3) / 3
    const horn = Math.sin(TAU * 311 * t) * 0.05 * Math.exp(-hornT * 9) * (t < 3 ? 1 : 0)
    x[i] = (breeze * 0.7 + rumble + horn) * (1 + 0.12 * Math.sin(TAU * 0.31 * t))
  }
  writeWav('ambient.wav', norm(makeLoop(x, 0.08), 0.85))
}

// --- one-shots -------------------------------------------------------------
const burst = (dur, fn) => {
  const n = secs(dur)
  const x = new Float64Array(n)
  for (let i = 0; i < n; i += 1) x[i] = fn(i / SR, i)
  return x
}

// footstep: soft noise tap
writeWav('footstep.wav', norm(burst(0.13, (t) => {
  let s = { y: 0 }
  return lowpass(rnd() * 2, 0.25, s) * Math.exp(-t * 55)
})))

// gunshot: crack + body thump
writeWav('gunshot.wav', norm(burst(0.3, (t, i) => {
  const crack = rnd() * Math.exp(-t * 70)
  const thump = Math.sin(TAU * 68 * t) * Math.exp(-t * 22) * 0.9
  return crack + thump
})))

// reload: two mechanical clicks + a slide
writeWav('reload.wav', norm(burst(0.55, (t) => {
  const c1 = t < 0.08 ? rnd() * Math.exp(-((t - 0.02) * 260)) : 0
  const c2 = t > 0.32 ? rnd() * Math.exp(-((t - 0.33) * 220)) : 0
  const slide = t > 0.1 && t < 0.34 ? lowpass(rnd() * 2, 0.5, { y: 0 }) * 0.25 : 0
  return c1 + c2 + slide
})))

// pickup: bright two-note blip
writeWav('pickup.wav', norm(burst(0.22, (t) => {
  const f = t < 0.09 ? 660 : 990
  return Math.sin(TAU * f * t) * Math.exp(-t * 16)
})))

// door: thunk + latch click
writeWav('door.wav', norm(burst(0.24, (t) => {
  const thunk = Math.sin(TAU * 92 * t) * Math.exp(-t * 34)
  const click = t > 0.14 ? rnd() * Math.exp(-((t - 0.15) * 300)) : 0
  return thunk * 0.9 + click
})))

// hit: short high tick (hitmarker)
writeWav('hit.wav', norm(burst(0.09, (t) => Math.sin(TAU * 1250 * t) * Math.exp(-t * 90))))

// wheel: airy whoosh (weapon wheel open)
writeWav('wheel.wav', norm(burst(0.2, (t) => {
  const env = Math.sin(Math.PI * clamp(t / 0.2, 0, 1))
  let s = { y: 0 }
  return lowpass(rnd() * 2, 0.55, s) * env
})))

// Crash: metallic clatter (car damage)
writeWav('crash.wav', norm(burst(0.45, (t) => {
  const clatter = rnd() * Math.exp(-t * 16)
  const ding = (Math.sin(TAU * 240 * t) * 0.4 + Math.sin(TAU * 397 * t) * 0.3) * Math.exp(-t * 11)
  return clatter * 0.8 + ding
})))

// horn: short two-tone traffic horn (distant car horn one-shot)
writeWav('horn.wav', norm(burst(0.5, (t) => {
  const env = Math.exp(-t * 5)
  return (Math.sin(TAU * 370 * t) * 0.5 + Math.sin(TAU * 466 * t) * 0.35) * env
})))

console.log('done -> ' + outDir)
