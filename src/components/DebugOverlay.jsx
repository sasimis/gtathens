import { useFrame } from '@react-three/fiber'
import { useRapier } from '@react-three/rapier'

let lastSample = 0
let frames = 0
let fpsValue = 0
let fpsWindowStart = 0

// Module-level snapshot, mutated in place every sample (see useFrame).
const statsSnap = {
  fps: 0,
  calls: 0,
  tris: 0,
  geos: 0,
  tex: 0,
  heapMB: -1,
  bodies: -1,
  colliders: -1,
}

const DebugOverlay = () => {
  let world = null
  try {
    const ctx = useRapier()
    world = ctx ? ctx.world : null
  } catch (e) {
    world = null
  }

  useFrame(({ gl }) => {
    const now = performance.now()
    frames += 1
    if (fpsWindowStart === 0) fpsWindowStart = now
    if (now - fpsWindowStart >= 500) {
      fpsValue = Math.round((frames * 1000) / (now - fpsWindowStart))
      frames = 0
      fpsWindowStart = now
    }
    if (now - lastSample < 300) return
    lastSample = now
    // Reused snapshot object: allocating a fresh one 3x/sec is pointless GC
    // churn, and a stable reference means `window.__gtathensStats` in the
    // console always shows the CURRENT numbers instead of a stale copy.
    const snap = statsSnap
    snap.fps = fpsValue
    const info = gl.info
    const mem = performance.memory
    let bodies = -1
    let colliders = -1
    try {
      if (world) {
        if (world.bodies && typeof world.bodies.len === 'function') bodies = world.bodies.len()
        else if (typeof world.numBodies === 'function') bodies = world.numBodies()
        if (world.colliders && typeof world.colliders.len === 'function') colliders = world.colliders.len()
        else if (typeof world.numColliders === 'function') colliders = world.numColliders()
      }
    } catch (err) { /* ignore */ }
    snap.calls = info.render.calls
    snap.tris = info.render.triangles
    snap.geos = info.memory.geometries
    snap.tex = info.memory.textures
    snap.heapMB = mem ? Math.round(mem.usedJSHeapSize / 1048576) : -1
    snap.bodies = bodies
    snap.colliders = colliders
    const el = document.getElementById('gtathens-debug')
    if (el && window.__gtathensDebugOpen) {
      el.textContent =
        'FPS ' + snap.fps +
        ' | calls ' + snap.calls +
        ' | tris ' + snap.tris +
        ' | geo ' + snap.geos +
        ' | tex ' + snap.tex +
        ' | heap ' + (snap.heapMB >= 0 ? snap.heapMB + 'MB' : 'n/a') +
        ' | bodies ' + snap.bodies +
        ' | colliders ' + snap.colliders
    }
  })

  return null
}

if (typeof window !== 'undefined') {
  window.__gtathensDebugOpen = false
  // Publish the reusable snapshot object itself (not a copy) so the console
  // API `window.__gtathensStats` always reflects the latest sample.
  window.__gtathensStats = statsSnap
  window.__gtathensDebug = window.__gtathensDebug || {}
  window.__gtathensDebug.toggle = () => {
    window.__gtathensDebugOpen = !window.__gtathensDebugOpen
    const el = document.getElementById('gtathens-debug')
    if (el) el.style.display = window.__gtathensDebugOpen ? 'block' : 'none'
    return window.__gtathensDebugOpen
  }
  window.__gtathensDebug.colliders = (v) => {
    if (typeof window.__gtathensSetColliders === 'function') {
      window.__gtathensSetColliders(typeof v === 'boolean' ? v : undefined)
    }
  }
  if (!window.__gtathensDebugKeys) {
    window.__gtathensDebugKeys = true
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyH' && window.__gtathensDebug) window.__gtathensDebug.toggle()
      if (e.code === 'KeyG' && window.__gtathensDebug) window.__gtathensDebug.colliders()
    })
  }
}

export default DebugOverlay
