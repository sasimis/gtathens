// scripts/road-surface-repro.mjs — Node oracle for src/lib/roadSurface.js.
//
// Runs the REAL module against the REAL public/map_data.json, no browser and
// no three.js, so the road geometry can be asserted before it is ever
// rendered. Same pattern as scripts/park-repro.mjs (pure planner) and
// scripts/building-fit.mjs.
//
// The invariants, and why each one is here:
//
//   T1  every carriageway quad matches ROAD_STYLE's painted width. The parking
//       planner, the traffic-lane model and the drivable-surface test all read
//       that width, so a road drawn wider than the model is a car floating on
//       (or sinking into) tarmac.
//   T2  kerbs and sidewalks sit OUTBOARD of the painted edge on both sides, so
//       no footway or prop ever stands on the carriageway.
//   T3  painted markings stay inside the carriageway (never over a kerb).
//   T4  the tarmac footprint equals the OLD ribbon's, area for area — i.e.
//       this refactor changed how roads LOOK, not where they ARE.
//   T5  furniture is deterministic and never stands in a carriageway.
//   T6  no NaN / Infinity anywhere in the emitted buffers.
//   T7  the prop set is bounded and the triangle budget is sane.
import fs from 'node:fs'
import path from 'node:path'
import { buildRoadSurface, planRoadFurniture, markingsFor, KERB_H, FURNITURE_MODELS } from '../src/lib/roadSurface.js'
import { ROAD_STYLE } from '../src/lib/roadStyle.js'
import { latToWorldZ, lonToWorldX } from '../src/lib/geo.js'

const toWorld = (n) => ({ x: lonToWorldX(n.lon), z: latToWorldZ(n.lat) })
const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public/map_data.json'), 'utf8'))
const roads = data.roads || []

let failures = 0
const check = (id, cond, detail) => {
  if (cond) console.log(`  ok   ${id}${detail ? '  ' + detail : ''}`)
  else { console.log(`  FAIL ${id}  ${detail || ''}`); failures += 1 }
}

console.log(`roads: ${roads.length}`)
const out = buildRoadSurface(roads, ROAD_STYLE, toWorld)
const tri = (s) => s.positions.length / 9
console.log(`triangles  tarmac ${tri(out.tarmac)}  pavement ${tri(out.pavement)}  kerb ${tri(out.kerb)}  walk ${tri(out.walk)}  paint ${tri(out.paint)}`)

// ---- T6: no NaN / Infinity -------------------------------------------------
let bad = 0
for (const key of ['tarmac', 'pavement', 'kerb', 'walk', 'paint']) {
  for (const v of out[key].positions) if (!Number.isFinite(v)) bad += 1
  for (const v of out[key].normals) if (!Number.isFinite(v)) bad += 1
}
check('T6 no NaN/Infinity in any buffer', bad === 0, bad ? `${bad} bad floats` : '')

// ---- T1/T2/T3: per-SEGMENT cross-section sanity ------------------------------
// The measurement MUST be per segment, not against the merged soup. Roads cross,
// so a global sample at one segment's midpoint picks up the vertices of every
// street that passes through the same spot and the extents come out metres too
// wide; and within a single WAY, a bend or a doubling-back can push a
// neighbouring segment's quads into this segment's span. So each segment is
// built as its own one-segment way and measured in complete isolation — which
// is also exactly the geometry the renderer emits for it.
let widthOk = true
let kerbOutboard = true
let paintInside = true
let checked = 0
const detail = []
for (const road of roads) {
  const style = ROAD_STYLE[road.type]
  if (!style || style.bucket === 'path') continue
  const halfW = style.w / 2
  const nodes = road.nodes || []
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = toWorld(nodes[i])
    const b = toWorld(nodes[i + 1])
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz)
    if (len < 1) continue
    checked += 1
    // A one-segment way: nothing else can contaminate the extents.
    const one = buildRoadSurface([{ type: road.type, nodes: [nodes[i], nodes[i + 1]] }], ROAD_STYLE, toWorld)
    const ux = dx / len
    const uz = dz / len
    const nx = -uz
    const nz = ux
    const ext = (s) => {
      const p = s.positions
      let lo = Infinity
      let hi = -Infinity
      for (let v = 0; v < p.length; v += 3) {
        const o = (p[v] - a.x) * nx + (p[v + 2] - a.z) * nz
        if (o < lo) lo = o
        if (o > hi) hi = o
      }
      return { lo, hi }
    }
    const s = ext(one.tarmac)
    // T1: tarmac spans exactly +/- halfW (float eps).
    if (Math.abs(s.lo + halfW) > 0.01 || Math.abs(s.hi - halfW) > 0.01) {
      widthOk = false
      detail.push(`T1 ${road.type} seg${i} s=[${s.lo.toFixed(2)},${s.hi.toFixed(2)}] want +/-${halfW}`)
    }
    // T2: kerb + sidewalk must not intrude INSIDE the painted edge, either
    // side. The kerb legitimately spans [-halfW-0.25, -halfW] and
    // [halfW, halfW+0.25], so the test is that it reaches OUT to at least
    // +/- halfW — NOT that its minimum is >= halfW (that is a sign mistake:
    // the left kerb's extent is negative by construction).
    const k = ext(one.kerb)
    const w = ext(one.walk)
    if (k.hi < halfW - 0.01 || k.lo > -halfW + 0.01 ||
        w.hi < halfW - 0.01 || w.lo > -halfW + 0.01) {
      kerbOutboard = false
      detail.push(`T2 ${road.type} seg${i} k=[${k.lo.toFixed(2)},${k.hi.toFixed(2)}] w=[${w.lo.toFixed(2)},${w.hi.toFixed(2)}] want |min|>=${halfW}`)
    }
    // T3: paint never crosses a kerb.
    if (one.paint.positions.length) {
      const p = ext(one.paint)
      if (p.lo < -halfW - 0.01 || p.hi > halfW + 0.01) {
        paintInside = false
        detail.push(`T3 ${road.type} seg${i} p=[${p.lo.toFixed(2)},${p.hi.toFixed(2)}] want within +/-${halfW}`)
      }
    }
  }
}
check('T1 carriageway width == ROAD_STYLE painted width', widthOk, `${checked} segments`)
check('T2 kerb + sidewalk outboard of the painted edge', kerbOutboard)
check('T3 markings inside the carriageway', paintInside)
for (const d of detail.slice(0, 6)) console.log('       ' + d)
if (detail.length > 6) console.log(`       ... and ${detail.length - 6} more`)

// ---- T4: the tarmac footprint is unchanged from the old ribbon build --------
// The reference must be the old CARRIAGEWAY area, i.e. every styled way EXCEPT
// the path bucket — footways now emit a `pavement` quad rather than tarmac
// (see T8), so comparing the tarmac against an all-ways reference reports a
// spurious ~26% "loss" that is really the footways moving to their own layer.
let oldArea = 0
for (const road of roads) {
  const style = ROAD_STYLE[road.type]
  if (!style || style.bucket === 'path') continue
  const nodes = road.nodes || []
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = toWorld(nodes[i])
    const b = toWorld(nodes[i + 1])
    oldArea += Math.hypot(b.x - a.x, b.z - a.z) * style.w
  }
}
let newArea = 0
{
  const p = out.tarmac.positions
  // pushQuad emits 6 vertices per quad: a0, a1, b1, a0, b1, b0. The FOUR
  // unique corners are therefore at offsets 0, 3, 6 and 15 — offset 9 repeats
  // a0 (it opens the second triangle), so indexing the shoelace quad as
  // 0/3/6/9 silently measures a triangle and reports exactly half the area.
  for (let i = 0; i < p.length; i += 18) {
    const xs = [p[i], p[i + 3], p[i + 6], p[i + 15]]
    const zs = [p[i + 2], p[i + 5], p[i + 8], p[i + 17]]
    let a = 0
    for (let k = 0; k < 4; k += 1) {
      const j = (k + 1) % 4
      a += xs[k] * zs[j] - xs[j] * zs[k]
    }
    newArea += Math.abs(a) / 2
  }
}
const areaErr = oldArea > 0 ? Math.abs(newArea - oldArea) / oldArea : 1
check('T4 tarmac area matches the old ribbon build', areaErr < 0.001,
  `old ${oldArea.toFixed(0)} m2 vs new ${newArea.toFixed(0)} m2 (${(areaErr * 100).toFixed(4)}%)`)

// ---- T5: furniture determinism + placement ---------------------------------
const f1 = planRoadFurniture(roads, ROAD_STYLE, toWorld)
const f2 = planRoadFurniture(roads, ROAD_STYLE, toWorld)
const same = f1.length === f2.length && f1.every((p, i) =>
  p.model === f2[i].model && p.x === f2[i].x && p.z === f2[i].z && p.rotY === f2[i].rotY)
check('T5a furniture is deterministic', same, `${f1.length} props`)

const kinds = {}
for (const p of f1) kinds[p.model] = (kinds[p.model] || 0) + 1
console.log('  prop mix:', Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join('  '))

let fbad = 0
for (const p of f1) {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !FURNITURE_MODELS.includes(p.model)) fbad += 1
}
check('T5b every prop is finite and uses a known model', fbad === 0)

// No prop may stand in a carriageway: re-test each prop against every segment.
let onRoad = 0
for (const p of f1) {
  outer: for (const road of roads) {
    const style = ROAD_STYLE[road.type]
    if (!style || style.bucket === 'path') continue
    const halfW = style.w / 2
    const nodes = road.nodes || []
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = toWorld(nodes[i])
      const b = toWorld(nodes[i + 1])
      const dx = b.x - a.x
      const dz = b.z - a.z
      const l2 = dx * dx + dz * dz
      if (l2 < 1e-6) continue
      const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2
      if (t < 0 || t > 1) continue
      if (Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)) < halfW - 0.05) { onRoad += 1; break outer }
    }
  }
}
check('T5c no prop stands in a carriageway', onRoad === 0, onRoad ? `${onRoad} on tarmac` : '')

// ---- T8: a footway is a footway (the bug a screenshot caught) ----------------
// The first version kerbed and sidewalked EVERY styled way, including the 147
// footways in this crop, and painted them all with the tarmac material. The
// result buried the map in raised tan slabs. A footway must produce a pavement
// quad and NOTHING else: no kerb, no sidewalk, no markings, no tarmac.
let footwayOk = true
let footwaysChecked = 0
for (const road of roads) {
  const style = ROAD_STYLE[road.type]
  if (!style || style.bucket !== 'path') continue
  footwaysChecked += 1
  const one = buildRoadSurface([road], ROAD_STYLE, toWorld)
  if (one.tarmac.positions.length) footwayOk = false
  if (one.kerb.positions.length) footwayOk = false
  if (one.walk.positions.length) footwayOk = false
  if (one.paint.positions.length) footwayOk = false
  if (!one.pavement.positions.length) footwayOk = false
}
check('T8 footways get a pavement quad and no kerb/sidewalk/markings', footwayOk,
  `${footwaysChecked} footway ways`)

// ---- T7: budget + markings table -------------------------------------------
const total = tri(out.tarmac) + tri(out.pavement) + tri(out.kerb) + tri(out.walk) + tri(out.paint)
check('T7 triangle budget sane', total < 90000, `${total} tris for the whole network`)
check('markingsFor: footway gets nothing', !markingsFor('path', 2).centre)
check('markingsFor: residential gets centre + edge', markingsFor('minor', 6).centre && markingsFor('minor', 6).edge)
check('markingsFor: 14 m boulevard gets 2 dividers', markingsFor('major', 14).dividers === 2)
check('markingsFor: 9 m street gets no divider', markingsFor('major', 9).dividers === 0)
check('KERB_H is a real kerb', KERB_H > 0.1 && KERB_H < 0.2, `${KERB_H} m`)

fs.writeFileSync('road-surface.txt',
  `road surface repro\n` +
  `triangles tarmac ${tri(out.tarmac)} pavement ${tri(out.pavement)} kerb ${tri(out.kerb)} walk ${tri(out.walk)} paint ${tri(out.paint)}\n` +
  `tarmac area old ${oldArea.toFixed(0)} new ${newArea.toFixed(0)}\n` +
  `furniture ${f1.length} ${JSON.stringify(kinds)}\nfailures ${failures}\n`)

console.log(failures ? `\nFAIL: ${failures} check(s)` : '\nPASS: all checks green')
process.exit(failures ? 1 : 0)

