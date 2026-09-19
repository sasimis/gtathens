// Bakes the world ground's pavement tile from the KayKit City Builder Bits
// palette atlas (pure Node, no deps).
//
//   cd workspace && node scripts/bake-pavement.mjs
//
// The pack's `citybits_texture.png` is an 8x8 PALETTE ATLAS: every 128 px cell
// is a flat colour with a baked light->dark gradient (no tiling detail at all).
// So "use the KayKit material" = paint the ground with the pack's OWN flat
// low-poly colours instead of a photo texture. This script:
//   1. decodes the atlas,
//   2. reads the UV rects the pack's own `base.gltf` (the sidewalk tile every
//      KayKit building sits on) and `road_straight.gltf` sample, and measures
//      their real colours,
//   3. bakes a 512 px / 16 m pavement tile (8x8 slabs of 2 m) out of those
//      palette greys: flat per-slab colour + the atlas' diagonal gradient +
//      dark joints + a wider expansion joint every 4 slabs.
// Output: public/textures/kaykit-pavement.png
// (TILE_M here MUST stay in sync with components/Ground.jsx.)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PACK = path.resolve(here, '../../KayKit_City_Builder_Bits_1.0_FREE/Assets')
const ATLAS = path.join(PACK, 'texture/citybits_texture.png')
const GLTF = path.join(PACK, 'gltf')
const OUT = path.resolve(here, '../public/textures/kaykit-pavement.png')

const S = 1024          // texture size (px)
const TILE_M = 32       // world metres covered by one tile (256 slabs = little visible repeat)
const SLAB_M = 2        // paving slab size (m) -> 16x16 slabs per tile
const N = TILE_M / SLAB_M
const CELL = S / N      // px per slab
const JOINT = 3         // grout line width (px) ~9 cm

/* ---------------------------------------------------------------- PNG in */

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
const crc32 = (b) => {
  let c = -1
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const pngChunk = (type, data) => {
  const b = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(b))
  return Buffer.concat([len, b, cr])
}

/** Decodes an 8-bit RGB/RGBA PNG into {w, h, at(x,y,k)}. */
const decodePng = (file) => {
  const buf = fs.readFileSync(file)
  let p = 8
  const idat = []
  let w, h, depth, color
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (depth !== 8 || (color !== 6 && color !== 2)) throw new Error('expected 8-bit RGB/RGBA png')
  const ch = color === 6 ? 4 : 3
  const raw = Buffer.from(zlib.inflateSync(Buffer.concat(idat)))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let q = 0
  for (let y = 0; y < h; y++) {
    const f = raw[q++]
    for (let x = 0; x < stride; x++) {
      const a = x - ch >= 0 ? out[y * stride + x - ch] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x - ch >= 0 && y > 0 ? out[(y - 1) * stride + x - ch] : 0
      let v = raw[q++]
      if (f === 1) v = (v + a) & 255
      else if (f === 2) v = (v + b) & 255
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      out[y * stride + x] = v
    }
  }
  return { w, h, at: (x, y, k) => out[y * stride + x * ch + k] }
}

/* --------------------------------------------------------------- glTF in */

const COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

/** Reads a pack mesh (POSITION/NORMAL/TEXCOORD_0 + indices) out of its .bin. */
const readMesh = (name) => {
  const g = JSON.parse(fs.readFileSync(path.join(GLTF, `${name}.gltf`), 'utf8'))
  const bin = fs.readFileSync(path.join(GLTF, `${name}.bin`))
  const acc = (i) => {
    const a = g.accessors[i]
    const bv = g.bufferViews[a.bufferView]
    const size = COMP[a.componentType]
    const n = NCOMP[a.type]
    const stride = bv.byteStride || size * n
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0)
    const read = {
      5120: (o) => bin.readInt8(o), 5121: (o) => bin.readUInt8(o),
      5122: (o) => bin.readInt16LE(o), 5123: (o) => bin.readUInt16LE(o),
      5125: (o) => bin.readUInt32LE(o), 5126: (o) => bin.readFloatLE(o),
    }[a.componentType]
    const out = []
    for (let k = 0; k < a.count; k++) {
      const o = start + k * stride
      const v = []
      for (let c = 0; c < n; c++) v.push(read(o + c * size))
      out.push(n === 1 ? v[0] : v)
    }
    return out
  }
  const prim = g.meshes[0].primitives[0]
  return {
    pos: acc(prim.attributes.POSITION),
    uv: acc(prim.attributes.TEXCOORD_0),
    nrm: acc(prim.attributes.NORMAL),
    idx: acc(prim.indices),
  }
}

/** UV rect + median sRGB of the UP-facing triangles of a pack mesh. */
const topFaceColor = (mesh, atlas) => {
  let u0 = 1, u1 = 0, v0 = 1, v1 = 0
  let tris = 0
  for (let t = 0; t < mesh.idx.length; t += 3) {
    const a = mesh.idx[t], b = mesh.idx[t + 1], c = mesh.idx[t + 2]
    if ((mesh.nrm[a][1] + mesh.nrm[b][1] + mesh.nrm[c][1]) / 3 < 0.7) continue
    tris++
    for (const i of [a, b, c]) {
      u0 = Math.min(u0, mesh.uv[i][0]); u1 = Math.max(u1, mesh.uv[i][0])
      v0 = Math.min(v0, mesh.uv[i][1]); v1 = Math.max(v1, mesh.uv[i][1])
    }
  }
  // Median of a 60% inset sample (skips swatch edge darkening / streaks).
  const acc = [[], [], []]
  const px0 = Math.round((u0 + (u1 - u0) * 0.2) * atlas.w)
  const px1 = Math.round((u0 + (u1 - u0) * 0.8) * atlas.w)
  const py0 = Math.round((v0 + (v1 - v0) * 0.2) * atlas.h)
  const py1 = Math.round((v0 + (v1 - v0) * 0.8) * atlas.h)
  for (let y = py0; y <= py1; y++) {
    for (let x = px0; x <= px1; x++) {
      for (let k = 0; k < 3; k++) acc[k].push(atlas.at(x, y, k))
    }
  }
  const med = acc.map((a) => a.sort((p, q) => p - q)[a.length >> 1])
  // Most common 16-step colour buckets: a mesh whose UVs span several atlas
  // cells (the road tiles do) has a meaningless median, but the dominant
  // buckets still name the real surface colours.
  const hist = new Map()
  for (let i = 0; i < acc[0].length; i++) {
    const q = (acc[0][i] >> 4) * 256 + (acc[1][i] >> 4) * 16 + (acc[2][i] >> 4)
    let e = hist.get(q)
    if (!e) { e = [0, [0, 0, 0]]; hist.set(q, e) }
    e[0]++
    for (let k = 0; k < 3; k++) e[1][k] += acc[k][i]
  }
  const top = [...hist.values()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 5)
    .map(([n, s]) => `${hex(s.map((v) => v / n))} ${(100 * n / acc[0].length).toFixed(0)}%`)
  const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]
  return { uv: [u0, v0, u1, v1], tris, rgb: med, top, p10: acc.map((a) => pct(a, 0.1)), p90: acc.map((a) => pct(a, 0.9)) }
}

const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const shade = (rgb, f) => rgb.map((v) => Math.max(0, Math.min(255, v * f)))

/** Deterministic hash, same recipe as lib/worldData.js hash01. */
const hash01 = (i) => {
  let h = (i * 2654435761) >>> 0
  h ^= h >>> 13
  h = (h * 1274126177) >>> 0
  return h / 4294967295
}

const atlas = decodePng(ATLAS)
const pavement = topFaceColor(readMesh('base'), atlas)
const asphalt = topFaceColor(readMesh('road_straight'), atlas)
console.log(`atlas          ${atlas.w}x${atlas.h}`)
console.log(`base top face  uv ${pavement.uv.map((v) => v.toFixed(4)).join(' ')}  ${pavement.tris} tris  rgb ${pavement.rgb.map(Math.round).join(',')}  ${hex(pavement.rgb)}`)
console.log(`  buckets ${pavement.top.join('  ')}   p10 ${hex(pavement.p10)}  p90 ${hex(pavement.p90)}`)
console.log(`road top face  uv ${asphalt.uv.map((v) => v.toFixed(4)).join(' ')}  ${asphalt.tris} tris  rgb ${asphalt.rgb.map(Math.round).join(',')}  ${hex(asphalt.rgb)}`)
console.log(`  buckets ${asphalt.top.join('  ')}   p10 ${hex(asphalt.p10)}  p90 ${hex(asphalt.p90)}`)

/* ------------------------------------------------------------- the tile */

const PAV = pavement.rgb          // the pack's own sidewalk concrete
const WARM = [150, 142, 128]      // a warmer "replaced paver" tone
// Small deterministic value steps between slabs. KayKit cells are FLAT
// colours, so the low-poly read comes from hard per-slab steps, not noise.
const SLAB_STEPS = [0, 0.04, -0.045, 0.075, -0.09, 0.025, -0.015, -0.13, 0.055, -0.065]
// Expansion joint every EXPAND slabs (grid readability at ground level).
const EXPAND = 4

const canvas = Buffer.alloc(S * S * 3)
const setPx = (x, y, rgb) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const o = (y * S + x) * 3
  canvas[o] = rgb[0]; canvas[o + 1] = rgb[1]; canvas[o + 2] = rgb[2]
}
// Light mortar grout between slabs, darker expansion joints every EXPAND slabs
// (the pack bakes its shading in, so the joints are what make the scale read).
const jointColor = shade(PAV, 0.72)
for (let i = 0; i < S * S; i++) setPx(i % S, Math.floor(i / S), jointColor)

// Slabs: flat palette colour + the atlas' diagonal light->dark gradient (every
// KayKit cell has that bake-in, and it is what makes the pack read low-poly).
for (let sy = 0; sy < N; sy++) {
  for (let sx = 0; sx < N; sx++) {
    const k = sx * 7 + sy * 131
    const step = SLAB_STEPS[Math.floor(hash01(k * 7919 + 5) * SLAB_STEPS.length) % SLAB_STEPS.length]
    let col = shade(PAV, 1 + step)
    if (hash01(k * 104729 + 11) > 0.94) {
      col = col.map((v, i) => v * 0.7 + WARM[i] * 0.3)
    }
    const x0 = sx * CELL + JOINT
    const y0 = sy * CELL + JOINT
    const w = CELL - JOINT * 2
    for (let y = y0; y < y0 + w; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const t = ((x - x0) / w + (y - y0) / w) * 0.5   // 0 = top-left .. 1 = bottom-right
        const g = 1.1 - t * 0.22                       // atlas-style baked gradient
        setPx(x, y, [col[0] * g, col[1] * g, col[2] * g])
      }
    }
  }
}

const exColor = shade(PAV, 0.5)
for (let i = 0; i <= N; i += EXPAND) {
  for (let t = 0; t < 5; t++) {
    const p = i * CELL - 2 + t
    for (let q = 0; q < S; q++) { setPx(p, q, exColor); setPx(q, p, exColor) }
  }
}

// A whisper of grain so it is not flat vector art up close (mipmaps average it
// away at distance), plus two hairline cracks per tile.
for (let i = 0; i < 2600; i++) {
  const x = Math.floor(hash01(i * 3 + 1) * S)
  const y = Math.floor(hash01(i * 7 + 2) * S)
  const o = (y * S + x) * 3
  const f = hash01(i * 13 + 3) > 0.5 ? 1.035 : 0.965
  for (let c = 0; c < 3; c++) canvas[o + c] = Math.min(255, canvas[o + c] * f)
}
const crackColor = shade(PAV, 0.55)
for (let c = 0; c < 2; c++) {
  let x = hash01(c * 101 + 11) * S
  let y = hash01(c * 103 + 23) * S
  for (let s = 0; s < 46; s++) {
    x += (hash01(c * 977 + s * 31 + 7) - 0.5) * 9
    y += hash01(c * 587 + s * 17 + 3) * 4 - 1.6
    setPx(Math.floor(x), Math.floor(y), crackColor)
    setPx(Math.floor(x) + 1, Math.floor(y), crackColor)
  }
}

/* ---------------------------------------------------------------- PNG out */

const rows = []
for (let y = 0; y < S; y++) {
  const row = Buffer.alloc(1 + S * 3)
  row[0] = 0
  canvas.copy(row, 1, y * S * 3, (y + 1) * S * 3)
  rows.push(row)
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0)),
])
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, png)
console.log(`baked pavement ${S}px = ${TILE_M} m  (${SLAB_M} m slabs, ${N}x${N})  slab ${hex(shade(PAV, 1.02))}  joint ${hex(jointColor)}`)
console.log(`wrote          public/textures/kaykit-pavement.png  ${png.length} bytes`)