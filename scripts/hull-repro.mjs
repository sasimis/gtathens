// Standalone proof of the ConvexHullCollider crash + fix.
//   1) reproduces @react-three/rapier's scaleVertices() on the OLD nested
//      [x,y,z] array input (what crashed the game), and
//   2) shows the NEW flat Float32Array input builds a collider fine.
//
//   node scripts/hull-repro.mjs
import RAPIER from '@dimforge/rapier3d-compat'
import { writeFileSync, appendFileSync } from 'node:fs'

const F = new URL('./hull-repro.txt', import.meta.url).pathname.replace(/^\//, '')
writeFileSync(F, '')
const w = (s) => appendFileSync(F, String(s) + '\r\n')

// Copied verbatim from @react-three/rapier's dist (scaleVertices).
const scaleVertices = (vertices, scale) => {
  const scaledVerts = Array.from(vertices)
  for (let i = 0; i < vertices.length / 3; i++) {
    scaledVerts[i * 3] *= scale.x
    scaledVerts[i * 3 + 1] *= scale.y
    scaledVerts[i * 3 + 2] *= scale.z
  }
  return scaledVerts
}

await RAPIER.init()
w('rapier3d-compat init OK')

const ring = [[-2, -2], [2, -2], [2, 2], [-2, 2]]
const h = 8

// ---- OLD (broken) input: nested arrays ----
const nested = []
for (const [x, z] of ring) nested.push([x, 0, z])
for (const [x, z] of ring) nested.push([x, h, z])
const scaledNested = scaleVertices(nested, { x: 1, y: 1, z: 1 })
w(`OLD nested: array length ${nested.length} (points ${nested.length}) ` +
  `-> scaleVertices loops ${Math.floor(nested.length / 3)}x (should be ${nested.length})`)
w('OLD nested after scaleVertices: ' + JSON.stringify(scaledNested).slice(0, 90))

// ---- NEW (fixed) input: flat Float32Array ----
const flat = new Float32Array(ring.length * 6)
let k = 0
for (const [x, z] of ring) { flat[k] = x; flat[k + 1] = 0; flat[k + 2] = z; k += 3 }
for (const [x, z] of ring) { flat[k] = x; flat[k + 1] = h; flat[k + 2] = z; k += 3 }
const scaledFlat = scaleVertices(flat, { x: 1, y: 1, z: 1 })
w(`NEW flat: array length ${flat.length} -> ${flat.length / 3} points, ` +
  `all finite after scaling: ${scaledFlat.every(Number.isFinite)}`)

const desc = RAPIER.ColliderDesc.convexHull(scaledFlat)
w('NEW ColliderDesc.convexHull(flat) -> ' + (desc ? 'OK (desc built)' : 'NULL'))

if (desc) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  world.createCollider(desc)
  world.step()
  w('NEW world stepped with hull collider; colliders=' + world.colliders.len())
  w('NEW collider half-extents: ' + JSON.stringify(desc.halfExtents ?
    { x: desc.halfExtents.x, y: desc.halfExtents.y, z: desc.halfExtents.z } : 'n/a'))
}

// ---- OLD input through the real API (expect a panic at collider creation) ----
// ColliderDesc.convexHull() is lazy: the raw shape (and therefore the WASM
// panic) only happens at intoRaw(), i.e. inside world.createCollider() — which
// is exactly where the browser stack trace pointed (convexHull -> intoRaw ->
// createCollider). Last, because a Rust panic can poison the module instance.
try {
  const bad = RAPIER.ColliderDesc.convexHull(scaledNested)
  w('OLD ColliderDesc.convexHull(nested) -> ' + (bad ? 'desc object (lazy, no panic yet)' : 'NULL'))
  if (bad) {
    const world2 = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    world2.createCollider(bad)
    w('OLD createCollider(nested hull) -> OK (unexpected! no crash)')
  }
} catch (e) {
  w('OLD createCollider(nested hull) -> PANIC: ' + e.constructor.name + ': ' + e.message)
}

w('done')
process.exit(0)