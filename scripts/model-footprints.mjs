// Measures the true XZ footprint SHAPE of every Kenney building model, so
// building colliders can be fitted to what the player actually SEES (the
// rendered mesh), not to the OSM paper outline.
//
//   node scripts/model-footprints.mjs
//
// Zero dependencies beyond three: parses each .glb directly (JSON + BIN
// chunks), walks the default scene applying node transforms, and projects
// every vertex to XZ. Reports, per model:
//   - XZ bounding box (model space) — what a box collider would cover,
//   - hullArea / aabbArea — 1.0 means the footprint really is a full box;
//     below ~0.9 means the model has notches (L-shape, silo gaps, trees...)
//     and a box collider would wall off invisible area.
import fs from 'node:fs'
import path from 'node:path'

const MODELS_DIR = path.join(process.cwd(), 'public/models/kenney')

const letters = 'abcdefghijklmnopqrstuvwx'.split('')
const MODEL_IDS = [
  ...letters.slice(0, 14).map((l) => `commercial/building-${l}`),
  ...letters.slice(0, 5).map((l) => `commercial/building-skyscraper-${l}`),
  ...letters.slice(0, 21).map((l) => `suburban/building-type-${l}`),
  ...letters.slice(0, 20).map((l) => `industrial/building-${l}`),
]

// --- minimal glTF 2.0 (.glb) reader: only what Kenney kits use ------------
const readGLB = (buf) => {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB')
  let off = 12
  let json = null
  let bin = null
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    const start = off + 8
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf.buffer, buf.byteOffset + start, len)))
    else if (type === 0x004e4942) bin = new Uint8Array(buf.buffer, buf.byteOffset + start, len)
    off = start + len
  }
  return { json, bin }
}

const readVec3s = (json, bin, accessorIndex, out, matrix) => {
  const acc = json.accessors[accessorIndex]
  if (acc.componentType !== 5126 || acc.type !== 'VEC3') throw new Error('unsupported accessor')
  const bv = json.bufferViews[acc.bufferView]
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0)
  const f32 = new Float32Array(bin.buffer, bin.byteOffset + base, acc.count * 3)
  const m = matrix
  for (let i = 0; i < f32.length; i += 3) {
    const x = f32[i]
    const y = f32[i + 1]
    const z = f32[i + 2]
    out.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[2] * x + m[6] * y + m[10] * z + m[14])
  }
}

// Compose TRS/matrix into a Matrix4 (column-major glTF layout).
const nodeMatrix = (n) => {
  if (n.matrix) return n.matrix
  const t = n.translation || [0, 0, 0]
  const r = n.rotation || [0, 0, 0, 1]
  const s = n.scale || [1, 1, 1]
  const [x, y, z, w] = r
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]
}

const matMul = (a, b) => {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}

// XZ convex hull area (Andrew monotone chain) over collected points.
const hullAreaXZ = (pts) => {
  const seen = new Map()
  for (let i = 0; i < pts.length; i += 2) seen.set(`${pts[i].toFixed(3)},${pts[i + 1].toFixed(3)}`, [pts[i], pts[i + 1]])
  const P = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (P.length < 3) return 0
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = []
  for (const p of P) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop()
    lo.push(p)
  }
  const up = []
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i]
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop()
    up.push(p)
  }
  lo.pop()
  up.pop()
  const h = lo.concat(up)
  let a = 0
  for (let i = 0; i < h.length; i++) {
    const p = h[i]
    const q = h[(i + 1) % h.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(a) / 2
}

console.log('model'.padEnd(34), 'verts'.padStart(8), 'xz-aabb'.padStart(9), 'hull/aabb')
for (const id of MODEL_IDS) {
  try {
    const { json, bin } = readGLB(fs.readFileSync(path.join(MODELS_DIR, `${id}.glb`)))
    const pts = []
    const walk = (nodeIndex, parent) => {
      const n = json.nodes[nodeIndex]
      const m = matMul(parent, nodeMatrix(n))
      if (n.mesh != null) {
        for (const prim of json.meshes[n.mesh].primitives) {
          if (prim.attributes.POSITION != null) readVec3s(json, bin, prim.attributes.POSITION, pts, m)
        }
      }
      for (const c of n.children || []) walk(c, m)
    }
    const scene = json.scenes[json.scene || 0]
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    for (const ni of scene.nodes) walk(ni, I)

    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < x0) x0 = pts[i]
      if (pts[i] > x1) x1 = pts[i]
      if (pts[i + 1] < z0) z0 = pts[i + 1]
      if (pts[i + 1] > z1) z1 = pts[i + 1]
    }
    const aabb = (x1 - x0) * (z1 - z0)
    const ratio = aabb > 0 ? hullAreaXZ(pts) / aabb : 0
    console.log(
      id.padEnd(34),
      String(pts.length / 2).padStart(8),
      aabb.toFixed(1).padStart(9),
      (aabb > 0 ? (ratio).toFixed(3) : 'n/a'),
    )
  } catch (e) {
    console.log(id.padEnd(34), 'ERR', e.message.slice(0, 60))
  }
}
