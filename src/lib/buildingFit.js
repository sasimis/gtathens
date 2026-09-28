/* ------------------------------------------------------------------ */
/* Building footprint fitting: get EVERY OSM ring onto the map.        */
/*                                                                     */
/* Pure module (no THREE, no JSX) so Node can test it directly - the   */
/* same trick planParkingSpots.js / roadStyle.js use.                  */
/*                                                                     */
/* Why this exists: the old rule in planBuildings DELETED any building */
/* with a corner within (road half width + 2 m) of a road CENTRELINE.  */
/* In a city that is almost every building - it threw away 285 of the  */
/* 423 OSM ways and the skyline came out half empty. OSM rings do not   */
/* really sit on the street, they kiss the kerb, so:                   */
/*                                                                     */
/*   1. pushOutOfRoads() slides a ring that overlaps a carriageway off */
/*      it (measured: no ring in this map is buried deeper than 3 m,   */
/*      so the push always succeeds - nothing is deleted any more).    */
/*   2. fitBoxToRoads() shrinks the RENDERED box (the Kenney model is   */
/*      fitted to the bounding box) to the largest road-free rectangle  */
/*      inside the footprint, so an L-shaped or chamfered block never  */
/*      swallows a street.                                             */
/* ------------------------------------------------------------------ */

export const ROAD_CLEAR_M = 1.6 // building edge this far behind the kerb line
export const PUSH_PASSES = 4 // a block corner meets two streets: settle against both
export const PUSH_MAX_M = 6 // deeper than the worst real ring (3 m) = bad data, drop
export const PAINTED_MIN_W = 4.5 // only paved carriageways push; footways are pavement
const RING_STEP_M = 1.5 // ring densification for the clearance test
// A CAR is 1.9 m wide (HALF in car-modules/constants.js is 0.95 per side) and it
// drives along the kerb, so a building wall has to sit at least a car plus a
// little slack behind the carriageway EDGE - with a ~1 m set-back the AI traffic
// scraped every wall (smoke's fleet test fell to 56 %).
const KERB_K = 1.6 // rendered box keeps this much off the tarmac
const KERB_CELL_K = 0.71 // ...plus half a grid cell, so the box EDGE (not just the
// cell centre) clears the carriageway - see fitBoxToRoads()
export { KERB_K } // scripts/building-fit.mjs asserts the same clearance
const BOX_CELL_M = 1.0 // road-free rectangle search grid
const MAX_BOX_CELLS = 96 // grid bound so a 200 m block stays cheap
const MIN_BOX_SIDE = 2.0 // a usable building needs both sides this long
const MIN_BOX_AREA = 0.04 // ...and this much of the original footprint
const BOX_PROBE = 5 // shrinkBoxClear probe grid (BOX_PROBE^2 samples per try)

const distSqToSeg = (px, pz, x1, z1, x2, z2) => {
  const dx = x2 - x1
  const dz = z2 - z1
  const l2 = dx * dx + dz * dz
  let t = l2 > 1e-12 ? ((px - x1) * dx + (pz - z1) * dz) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ox = px - (x1 + dx * t)
  const oz = pz - (z1 + dz * t)
  return ox * ox + oz * oz
}

/* ------------------------------------------------------------------ */
/* Uniform grid over the paved road segments                          */
/* ------------------------------------------------------------------ */

const INDEX_CELL = 16

/** Bucket the paved road segments into a uniform grid (one Map key per cell). */
export const buildRoadIndex = (segs) => {
  const buckets = new Map()
  let maxHalfW = 0
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i]
    if (s.halfW > maxHalfW) maxHalfW = s.halfW
    const cx0 = Math.floor(Math.min(s.x1, s.x2) / INDEX_CELL)
    const cx1 = Math.floor(Math.max(s.x1, s.x2) / INDEX_CELL)
    const cz0 = Math.floor(Math.min(s.z1, s.z2) / INDEX_CELL)
    const cz1 = Math.floor(Math.max(s.z1, s.z2) / INDEX_CELL)
    for (let cz = cz0; cz <= cz1; cz += 1) {
      for (let cx = cx0; cx <= cx1; cx += 1) {
        const key = `${cx},${cz}`
        let list = buckets.get(key)
        if (!list) { list = []; buckets.set(key, list) }
        list.push(s)
      }
    }
  }
  // Widest carriageway in the index. A road whose AABB does NOT touch a box can
  // still reach 8 m into it, so every query has to be expanded by this much -
  // querying the bare box silently missed the wide roads (a primary 3 m from the
  // footprint was "invisible" and its block covered a 12 m street).
  return { cell: INDEX_CELL, buckets, maxHalfW }
}

/** Appends every segment overlapping the box into `out` (de-duplicated). */
export const segsInBox = (index, minX, maxX, minZ, maxZ, out) => {
  out.length = 0
  if (!index || !index.buckets.size) return out
  const c = index.cell
  const cx0 = Math.floor(minX / c)
  const cx1 = Math.floor(maxX / c)
  const cz0 = Math.floor(minZ / c)
  const cz1 = Math.floor(maxZ / c)
  for (let cz = cz0; cz <= cz1; cz += 1) {
    for (let cx = cx0; cx <= cx1; cx += 1) {
      const list = index.buckets.get(`${cx},${cz}`)
      if (!list) continue
      for (const s of list) if (!out.includes(s)) out.push(s)
    }
  }
  return out
}

const centroid = (ring, out) => {
  let x = 0
  let z = 0
  for (const p of ring) { x += p[0]; z += p[1] }
  out[0] = x / ring.length
  out[1] = z / ring.length
  return out
}

/** Densifies a ring so a long edge cannot hide between the samples. */
export const densifyRing = (ring, step, out) => {
  out.length = 0
  const n = ring.length
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const steps = Math.max(1, Math.ceil(len / step))
    for (let s = 0; s < steps; s += 1) {
      out.push([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps])
    }
  }
  return out
}

/**
 * Translates `outline` ([[x, z], ...], mutated in place) until no point of the
 * ring is inside a carriageway. `scratch` is a reusable [[],[],[]] holding
 * samples / candidate segments / the centre. Returns { x, z, pushed } for the
 * new centre, or null when the ring is so deep in the road that placing it
 * would be nonsense.
 */
export const pushOutOfRoads = (outline, index, scratch) => {
  const [samples, segs, mid] = scratch
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity
  for (const p of outline) {
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] < minZ) minZ = p[1]
    if (p[1] > maxZ) maxZ = p[1]
  }
  const reach = ROAD_CLEAR_M + (index ? index.maxHalfW : 0) + 2
  centroid(outline, mid)
  let pushed = 0
  for (let pass = 0; pass < PUSH_PASSES; pass += 1) {
    segsInBox(index, minX - reach, maxX + reach, minZ - reach, maxZ + reach, segs)
    if (!segs.length) break
    densifyRing(outline, RING_STEP_M, samples)
    let bestDepth = 0
    let bestNx = 0
    let bestNz = 0
    for (const seg of segs) {
      const need = seg.halfW + ROAD_CLEAR_M
      const needSq = need * need
      const dx = seg.x2 - seg.x1
      const dz = seg.z2 - seg.z1
      const len = Math.hypot(dx, dz)
      if (len < 1e-6) continue
      const nx = -dz / len
      const nz = dx / len
      for (const p of samples) {
        const distSq = distSqToSeg(p[0], p[1], seg.x1, seg.z1, seg.x2, seg.z2)
        if (distSq >= needSq) continue
        const depth = need - Math.sqrt(distSq)
        if (depth <= bestDepth) continue
        const side = Math.sign((p[0] - seg.x1) * nx + (p[1] - seg.z1) * nz) || 1
        bestDepth = depth
        bestNx = nx * side
        bestNz = nz * side
      }
    }
    if (bestDepth <= 0.02) break
    pushed += bestDepth
    if (pushed > PUSH_MAX_M) return null
    mid[0] += bestNx * bestDepth
    mid[1] += bestNz * bestDepth
    for (const p of outline) { p[0] += bestNx * bestDepth; p[1] += bestNz * bestDepth }
    minX += bestNx * bestDepth; maxX += bestNx * bestDepth
    minZ += bestNz * bestDepth; maxZ += bestNz * bestDepth
  }
  return pushed > 0.01 ? { x: mid[0], z: mid[1], pushed } : null
}

/* ------------------------------------------------------------------ */
/* 2. largest road-free rectangle inside the footprint bbox            */
/* ------------------------------------------------------------------ */

/**
 * The Kenney model is fitted to the bounding box, so an L-shaped or
 * chamfered footprint would render as a box that swallows a street. Shrink the
 * box to the largest carriageway-free rectangle inside it (histogram maximal
 * rectangle). Returns { x, z, w, d } - the original box when it is already
 * clear or when shrinking would leave a useless sliver - or null when the whole
 * footprint is tarmac (the OSM ring is drawn on the street; nothing to place).
 */
export const fitBoxToRoads = (minX, maxX, minZ, maxZ, index) => {
  const w = maxX - minX
  const d = maxZ - minZ
  const full = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, w, d }
  if (!index || w <= 0 || d <= 0) return full
  // Tile the box EXACTLY: per-axis cell size, so a returned rectangle is a union
  // of whole cells and never needs clamping back to the bbox (a clamp re-aligns
  // the rectangle and pushes its edge back over the kerb - that was the last
  // handful of buildings with a block on the tarmac).
  const target = Math.max(BOX_CELL_M, Math.max(w, d) / MAX_BOX_CELLS)
  const cols = Math.max(1, Math.min(MAX_BOX_CELLS, Math.round(w / target)))
  const rows = Math.max(1, Math.min(MAX_BOX_CELLS, Math.round(d / target)))
  const cellX = w / cols
  const cellZ = d / rows
  // Half a cell diagonal: the rectangle covers whole cells, so a cell CENTRE
  // clearing the kerb is not enough - the box EDGE must clear it too.
  const kerb = KERB_K + Math.max(cellX, cellZ) * KERB_CELL_K
  // Widen the candidate query by the widest carriageway (see buildRoadIndex).
  const expand = (index.maxHalfW || 0) + kerb
  const segs = segsInBox(index, minX - expand, maxX + expand, minZ - expand, maxZ + expand, [])
  if (!segs.length) return full
  const blocked = new Uint8Array(cols * rows)
  let any = 0
  for (let r = 0; r < rows; r += 1) {
    const z = minZ + (r + 0.5) * cellZ
    for (let c = 0; c < cols; c += 1) {
      const x = minX + (c + 0.5) * cellX
      for (const s of segs) {
        const need = s.halfW + kerb
        if (distSqToSeg(x, z, s.x1, s.z1, s.x2, s.z2) < need * need) { blocked[r * cols + c] = 1; any += 1; break }
      }
    }
  }
  if (!any) return full
  // Histogram maximal rectangle: heights[c] = consecutive free cells upward.
  const heights = new Int32Array(cols)
  const stack = new Int32Array(cols + 1)
  let best = 0
  let br0 = 0; let bc0 = 0; let bc1 = 0; let br1 = 0
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) heights[c] = blocked[r * cols + c] ? 0 : heights[c] + 1
    let top = 0
    for (let c = 0; c <= cols; c += 1) {
      const h = c === cols ? 0 : heights[c]
      while (top > 0 && heights[stack[top - 1]] >= h) {
        const idx = stack[--top]
        const hh = heights[idx]
        const left = top > 0 ? stack[top - 1] + 1 : 0
        const area = hh * (c - left)
        if (area > best) { best = area; br0 = r - hh + 1; bc0 = left; bc1 = c; br1 = r }
      }
      if (c < cols) stack[top++] = c
    }
  }
  if (!best) return null // the whole footprint is tarmac
  const nw = (bc1 - bc0) * cellX
  const nd = (br1 - br0 + 1) * cellZ
  if (nw < MIN_BOX_SIDE || nd < MIN_BOX_SIDE) return null
  if (best * cellX * cellZ < w * d * MIN_BOX_AREA) return null
  return {
    x: minX + ((bc0 + bc1) / 2) * cellX,
    z: minZ + ((br0 + br1 + 1) / 2) * cellZ,
    w: nw,
    d: nd,
  }
}

/* ------------------------------------------------------------------ */
/* 3. hard guarantee: no rendered box may cover a carriageway          */
/* ------------------------------------------------------------------ */

const boxIsClear = (box, segs, minX, minZ) => {
  const hw = box.w / 2
  const hd = box.d / 2
  for (let a = 0; a < BOX_PROBE; a += 1) {
    const x = minX - hw + (box.w * a) / (BOX_PROBE - 1)
    for (let b = 0; b < BOX_PROBE; b += 1) {
      const z = minZ - hd + (box.d * b) / (BOX_PROBE - 1)
      for (const s of segs) {
        const need = s.halfW + KERB_K
        if (distSqToSeg(x, z, s.x1, s.z1, s.x2, s.z2) < need * need) return false
      }
    }
  }
  return true
}

/**
 * Final safety net for the rendered box: probe it on a grid and shrink it
 * towards its centre until nothing sits on tarmac (fitBoxToRoads already lands
 * inside whole free cells, this catches the rounding/diagonal leftovers).
 * Returns the box, or null when even a 2 m stub does not fit - then the caller
 * drops the building rather than park a block in the street.
 */
export const shrinkBoxClear = (box, index) => {
  if (!index) return box
  const segs = segsInBox(
    index,
    box.x - box.w / 2 - 12,
    box.x + box.w / 2 + 12,
    box.z - box.d / 2 - 12,
    box.z + box.d / 2 + 12,
    [],
  )
  if (!segs.length) return box
  const out = { x: box.x, z: box.z, w: box.w, d: box.d }
  for (let attempt = 0; attempt < 7; attempt += 1) {
    if (boxIsClear(out, segs, out.x, out.z)) return out
    out.w *= 0.75
    out.d *= 0.75
    if (out.w < MIN_BOX_SIDE || out.d < MIN_BOX_SIDE) return null
  }
  return boxIsClear(out, segs, out.x, out.z) ? out : null
}
