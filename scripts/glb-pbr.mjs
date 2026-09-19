// Dumps the GLB JSON chunk's material PBR factors + root node transform for
// the KayKit car models. Static check, no browser needed.
//   node scripts/glb-pbr.mjs
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models', 'cars')
for (const f of readdirSync(DIR).filter((n) => n.endsWith('.glb'))) {
  const b = readFileSync(path.join(DIR, f))
  const jl = b.readUInt32LE(12)
  const j = JSON.parse(b.slice(20, 20 + jl).toString())
  const mats = (j.materials || []).map((m) => ({
    name: m.name,
    pbr: m.pbrMetallicRoughness,
    ext: Object.keys(m.extensions || {}),
  }))
  console.log(f + ': ' + JSON.stringify(mats))
  const n0 = (j.nodes || [])[0] || {}
  console.log('  node0: ' + JSON.stringify({ name: (n0.name || '').slice(0, 24), rot: n0.rotation, scale: n0.scale, trans: n0.translation }))
  const prim = ((j.meshes || [])[0] || {}).primitives?.[0] || {}
  console.log('  attrs: ' + JSON.stringify(Object.keys(prim.attributes || {})))
}
