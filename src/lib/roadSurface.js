// lib/roadSurface.js — Kenney-styled ROAD SURFACE geometry, generated from the
// real OSM network.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A KENNEY TILE PLACER
// --------------------------------------------------------
// The Kenney "City Kit (Roads)" pack is a MODULAR KIT, not a road network: every
// piece is a 1x1 m unit tile (`road-straight` 1.0x1.0, `road-curve` 2.0x2.0,
// `road-roundabout` 3.0x3.0) with the kerbs, centre dashes and lane lines
// BAKED INTO THE TILE GEOMETRY as flat-coloured polygons sampling a colour
// atlas (measured: 72 verts, 9 distinct UVs, 1 material, no road texture).
// Tiling those onto this map is not possible: the map is real OSM — 266 ways /
// 1951 segments at arbitrary angles, widths from 2 m (footway) to 16 m
// (motorway) — so a fixed-width 1 m tile with baked markings would tear at
// every non-orthogonal bend, and snapping the network to a grid would destroy
// the geometry that parking, traffic lanes, the road pathfinder, the navmesh
// and building placement all read.
//
// So this module keeps the OSM geometry EXACTLY as it is and only rebuilds how
// the surface LOOKS, deriving the painted width from the same ROAD_STYLE table
// everything else uses. Result: Kenney's visual language (kerbs, a raised
// sidewalk, a dashed centre line, a solid edge line) on the real street
// layout, with no gameplay regression. The real Kenney MODELS are used
// separately as street furniture — see components/RoadFurniture.jsx.
//
// Pure module: no three.js, no React, no DOM. That is the same contract as
// lib/planParkingSpots.js + lib/buildingFit.js, and it is what lets
// scripts/road-surface-repro.mjs test the exact code the renderer runs in Node.
//
// Units are metres throughout (1 world unit = 1 m, see lib/geo.js).

/** Sidewalk width per road class. Wider arterial = wider pavement. */
const SIDEWALK_W = {
  major: 2.0,
  minor: 1.6,
}

/** Painted width of the centre line, and the dash rhythm. */
const CENTRE_W = 0.16
const DASH_LEN = 2.0
const DASH_GAP = 2.0

/** Painted width of the solid edge line that runs inside the kerb. */
const EDGE_W = 0.12

/** How far the kerb face stands proud of the road surface (metres). */
export const KERB_H = 0.14

/** Distance between lamp posts along a street (metres). */
export const LAMP_SPACING = 22

/**
 * Road classes get a different painted treatment, mirroring the Kenney tiles:
 * a two-way street gets a dashed centre line, a footway gets none, and a wide
 * boulevard gets extra dashed lane dividers. `dividers` is the number of extra
 * painted lines across the carriageway.
 */
export const markingsFor = (bucket, width) => {
  if (bucket === 'path') return { centre: false, dividers: 0, edge: false }
  if (bucket === 'minor') return { centre: true, dividers: 0, edge: true }
  // major: one dashed centre plus a divider per extra lane beyond 9 m.
  const dividers = width >= 13 ? 2 : width >= 9.5 ? 1 : 0
  return { centre: true, dividers, edge: true }
}

/**
 * A quad spanning lateral offsets [o0, o1] of the segment a->b, emitted into
 * `out` as two triangles. `nx,nz` is the segment's unit perpendicular.
 *
 * The road ribbons are drawn DoubleSide with explicit up normals (as the old
 * ribbons were), so a consistent winding is all that is required.
 */
const pushQuad = (out, ax, az, bx, bz, nx, nz, o0, o1, y) => {
  const p = out.positions
  const n = out.normals
  const a0x = ax - nx * o0
  const a0z = az - nz * o0
  const a1x = ax - nx * o1
  const a1z = az - nz * o1
  const b0x = bx - nx * o0
  const b0z = bz - nz * o0
  const b1x = bx - nx * o1
  const b1z = bz - nz * o1
  p.push(
    a0x, y, a0z, a1x, y, a1z, b1x, y, b1z,
    a0x, y, a0z, b1x, y, b1z, b0x, y, b0z,
  )
  for (let k = 0; k < 6; k += 1) n.push(0, 1, 0)
}

/**
 * A vertical face (the kerb's visible edge), emitted as a two-sided strip.
 * Without it a car standing at the kerb sees the sidewalk vanish edge-on.
 */
const pushKerbFace = (out, ax, az, bx, bz, nx, nz, off, yBottom, yTop) => {
  const p = out.positions
  const n = out.normals
  const a0x = ax - nx * off
  const a0z = az - nz * off
  const b0x = bx - nx * off
  const b0z = bz - nz * off
  // Two vertical quads back to back so the face is visible from both sides.
  p.push(
    a0x, yBottom, a0z, b0x, yBottom, b0z, b0x, yTop, b0z,
    a0x, yBottom, a0z, b0x, yTop, b0z, a0x, yTop, a0z,
  )
  for (let k = 0; k < 6; k += 1) n.push(-nx, 0, -nz)
  p.push(
    a0x, yBottom, a0z, b0x, yTop, b0z, b0x, yBottom, b0z,
    a0x, yBottom, a0z, a0x, yTop, a0z, b0x, yTop, b0z,
  )
  for (let k = 0; k < 6; k += 1) n.push(nx, 0, nz)
}

/** Empty triangle-soup accumulator. */
const soup = () => ({ positions: [], normals: [] })

/**
 * Build every road surface mesh for `roads` in one pass, returning flat
 * triangle soups ready for BufferGeometry:
 *
 *   tarmac   — the carriageway of a REAL street (minor/major). This is the
 *              surface the drivable-surface model, the lane planner and the
 *              parking planner all treat as road, and its footprint is
 *              identical to the old ribbons' (asserted by
 *              scripts/road-surface-repro.mjs T4).
 *   pavement — footways / paths / cycleways. Flat and pavement-coloured, and
 *              deliberately NOT tarmac and NOT kerbed: a footway is already a
 *              pavement, so giving it a kerb and a sidewalk gives it a second
 *              one. This crop has 147 footways, and treating them as streets
 *              buried the whole map in raised slabs.
 *   kerb     — the raised lip along a real street's painted edges.
 *   walk     — the sidewalk strip outboard of each kerb.
 *   paint    — centre dashes, lane dividers and solid edge lines.
 *
 * `toWorld(node)` maps an OSM node to world space (Roads.jsx passes the
 * geo.js projection). All y values are RELATIVE to the caller's base so the
 * component can place the whole set with one group y, as it always has.
 */
export const buildRoadSurface = (roads, ROAD_STYLE, toWorld) => {
  const tarmac = soup()
  const pavement = soup()
  const kerb = soup()
  const walk = soup()
  const paint = soup()

  // Layering. Tarmac lowest, paint just above it (otherwise markings z-fight
  // with the road at grazing angles), sidewalk next, kerb top last. The gaps
  // are ~0.01-0.02 m, far below the shadow-bias noise floor, so a 16 m
  // motorway does not look like it is floating.
  const Y_TAR = 0
  const Y_PAINT = 0.012
  const Y_WALK = 0.02
  const Y_KERB_TOP = KERB_H

  for (const road of roads || []) {
    const style = ROAD_STYLE[road.type]
    if (!style) continue
    const bucket = style.bucket
    const halfW = style.w / 2
    // A footway is a footway: no kerb, no sidewalk, no markings. Everything
    // below this guard only happens on a real carriageway.
    const isStreet = bucket !== 'path'
    const nodes = road.nodes || []

    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = toWorld(nodes[i])
      const b = toWorld(nodes[i + 1])
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len = Math.hypot(dx, dz)
      if (len < 0.05) continue
      const nx = -dz / len
      const nz = dx / len

      // --- surface ---------------------------------------------------------
      pushQuad(isStreet ? tarmac : pavement, a.x, a.z, b.x, b.z, nx, nz, -halfW, halfW, Y_TAR)
      if (!isStreet) continue

      const swW = SIDEWALK_W[bucket] ?? 1.6
      const mk = markingsFor(bucket, style.w)

      // --- kerb + sidewalk, both sides -----------------------------------
      for (const side of [1, -1]) {
        const eIn = side * halfW
        const eOut = side * (halfW + 0.25)
        // Kerb top (a narrow cap) and its vertical face at the painted edge.
        pushQuad(kerb, a.x, a.z, b.x, b.z, nx, nz, eIn, eOut, Y_KERB_TOP)
        pushKerbFace(kerb, a.x, a.z, b.x, b.z, nx, nz, eIn, Y_TAR, Y_KERB_TOP)
        // Sidewalk outboard of the kerb.
        pushQuad(walk, a.x, a.z, b.x, b.z, nx, nz, eOut, side * (halfW + 0.25 + swW), Y_WALK)
      }

      // --- painted lines --------------------------------------------------
      if (mk.edge) {
        for (const side of [1, -1]) {
          const inner = side * (halfW - 0.35 - EDGE_W)
          const outer = side * (halfW - 0.35)
          pushQuad(paint, a.x, a.z, b.x, b.z, nx, nz, inner, outer, Y_PAINT)
        }
      }

      if (mk.centre) {
        // Walk the centre line in dash/gap steps so a 180 m avenue does not
        // get one absurdly stretched dash, and so the rhythm stays even
        // instead of restarting at an arbitrary offset per segment.
        const period = DASH_LEN + DASH_GAP
        const count = Math.max(1, Math.floor(len / period))
        const step = len / count
        const dashLen = Math.min(DASH_LEN, step * 0.55)
        for (let d = 0; d < count; d += 1) {
          const t0 = d * step + (step - dashLen) / 2
          const t1 = t0 + dashLen
          const ax = a.x + dx * t0
          const az = a.z + dz * t0
          const bx = a.x + dx * t1
          const bz = a.z + dz * t1
          pushQuad(paint, ax, az, bx, bz, nx, nz, -CENTRE_W / 2, CENTRE_W / 2, Y_PAINT)
          for (let L = 1; L <= mk.dividers; L += 1) {
            // Evenly spread across the carriageway, inset from the kerbs.
            const off = (L / (mk.dividers + 1)) * (2 * halfW - 1.4) - halfW + 0.7
            pushQuad(paint, ax, az, bx, bz, nx, nz, off - CENTRE_W / 2, off + CENTRE_W / 2, Y_PAINT)
          }
        }
      }
    }
  }
  return { tarmac, pavement, kerb, walk, paint }
}

/**
 * Deterministic pseudo-random in [0,1) from an integer — the same trick
 * worldData.hash01 uses. Street furniture must be STABLE across reloads (a lamp
 * post that moves between frames is a bug, not variety), so every prop is
 * chosen by hashing its road/segment index, never by a per-frame coin flip.
 */
const hash01 = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Lateral offset of the sidewalk's standing line, inboard of the kerb. */
const STAND_OFF = (halfW) => halfW + 0.12

/**
 * Squared distance from (x,z) to the nearest PAINTED carriageway, and the
 * signed side it was on. Returns null when there is no road within range.
 *
 * This exists because the OSM ways in this crop do NOT share junction nodes
 * (2-10 m gaps, see the STITCH_R note in AGENTS.md), so the same physical
 * street is often carried by two nearly-parallel ways. A lamp placed legally
 * on road A's sidewalk can therefore land INSIDE road B's carriageway — which
 * is what put 187 of 477 props on tarmac before this check existed.
 */
const nearestTarmac = (x, z, roads, ROAD_STYLE, toWorld) => {
  let best = Infinity
  for (const road of roads) {
    const style = ROAD_STYLE[road.type]
    if (!style || style.bucket === 'path') continue
    const nodes = road.nodes || []
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = toWorld(nodes[i])
      const b = toWorld(nodes[i + 1])
      const dx = b.x - a.x
      const dz = b.z - a.z
      const l2 = dx * dx + dz * dz
      if (l2 < 1e-6) continue
      let t = ((x - a.x) * dx + (z - a.z) * dz) / l2
      if (t < 0) t = 0
      else if (t > 1) t = 1
      const cx = a.x + dx * t
      const cz = a.z + dz * t
      const d = Math.hypot(x - cx, z - cz) - style.w / 2
      if (d < best) best = d
    }
  }
  return best
}

/** The Kenney prop models this planner may emit, and their y offset. */
export const FURNITURE_MODELS = [
  'light-square-double',
  'light-curved-double',
  'road-sign-stop',
  'road-sign-street',
  'traffic-light',
  'electricity-pole-single',
]

/**
 * Place street furniture along the real OSM ways: a lamp post every
 * LAMP_SPACING metres on every paved street (alternating sides, jittered
 * slightly so a run of lamps is not a ruler-straight line), a stop sign and
 * a street-name sign where a NAMED way begins, a telephone pole every 40 m on
 * the widest streets, and a traffic light where two different named ways meet.
 *
 * Pure and deterministic — the same roads array always yields the same props,
 * which is what lets scripts/road-surface-repro.mjs assert exact counts.
 * Returns a flat array of `{ model, x, z, rotY }`.
 *
 * `rotY` is the yaw in radians, measured so the prop faces ALONG the road it
 * belongs to (a stop sign should be readable by a driver approaching it, not
 * edge-on to the traffic).
 */
export const planRoadFurniture = (roads, ROAD_STYLE, toWorld) => {
  const props = []
  const named = []

  roads.forEach((road, ri) => {
    const style = ROAD_STYLE[road.type]
    if (!style || style.bucket === 'path') return
    const halfW = style.w / 2
    const swW = SIDEWALK_W[style.bucket] ?? 1.6
    const name = typeof road.name === 'string' ? road.name.trim() : ''
    const nodes = road.nodes || []

    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = toWorld(nodes[i])
      const b = toWorld(nodes[i + 1])
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len = Math.hypot(dx, dz)
      if (len < 0.05) continue
      const yaw = Math.atan2(dx, dz)
      const nx = -dz / len
      const nz = dx / len
      const stand = STAND_OFF(halfW)

      // --- lamps, every LAMP_SPACING m, alternating sides -----------------
      const nLamps = Math.floor(len / LAMP_SPACING)
      for (let k = 1; k <= nLamps; k += 1) {
        const t = (k * LAMP_SPACING) / len
        if (t >= 1) break
        const side = (ri + k) % 2 === 0 ? 1 : -1
        // Jitter the distance from the kerb so a straight run of lamps is not
        // a perfectly ruled line — deterministic, so it never jitters on
        // reload.
        const inset = 0.15 + hash01(ri * 131 + i * 17 + k) * (swW - 0.4)
        const off = (stand + inset) * side
        props.push({
          model: hash01(ri * 29 + i * 3 + k) > 0.62 ? 'light-square-double' : 'light-curved-double',
          x: a.x + dx * t + nx * off,
          z: a.z + dz * t + nz * off,
          rotY: yaw,
        })
      }

      // --- telephone poles on the wide boulevards only ---------------------
      if (style.bucket === 'major' && style.w >= 12) {
        const nPoles = Math.floor(len / 40)
        for (let k = 1; k <= nPoles; k += 1) {
          const t = (k * 40) / len
          if (t >= 1) break
          const side = k % 2 === 0 ? 1 : -1
          const off = (halfW + 0.25 + swW + 0.3) * side
          props.push({
            model: 'electricity-pole-single',
            x: a.x + dx * t + nx * off,
            z: a.z + dz * t + nz * off,
            rotY: yaw,
          })
        }
      }

      if (!name) continue
      named.push({ name, ri, i, ax: a.x, az: a.z })

      // --- signage where a named street begins ----------------------------
      if (i === 0) {
        const side = hash01(ri * 7) > 0.5 ? 1 : -1
        props.push({
          model: 'road-sign-stop',
          x: a.x + nx * stand * side,
          z: a.z + nz * stand * side,
          rotY: yaw,
        })
        props.push({
          model: 'road-sign-street',
          x: a.x + nx * (stand + 0.45) * side + dx * 0.015,
          z: a.z + nz * (stand + 0.45) * side + dz * 0.015,
          rotY: yaw,
        })
      }
    }
  })

  // --- traffic lights where two DIFFERENT named ways meet --------------------
  // A signal needs two streets to be meaningful, so this is driven by the
  // named-way list rather than every junction in the graph.
  for (let x = 0; x < named.length; x += 1) {
    for (let y = x + 1; y < named.length; y += 1) {
      const A = named[x]
      const B = named[y]
      if (A.ri === B.ri || A.name === B.name) continue
      const d = Math.hypot(A.ax - B.ax, A.az - B.az)
      if (d > 14) continue
      if (hash01(A.ri * 53 + A.i * 7 + B.ri * 11 + B.i) > 0.45) continue
      props.push({
        model: 'traffic-light',
        x: (A.ax + B.ax) / 2,
        z: (A.az + B.az) / 2,
        rotY: Math.atan2(B.ax - A.ax, B.az - A.az),
      })
    }
  }

  // --- reject anything that ended up standing in tarmac ----------------------
  // Placement above only knows about the road it placed the prop on. Because
  // this map's ways do not share nodes, a SECOND way can run right alongside,
  // so a lamp that is legally on road A's kerb can still be inside road B's
  // carriageway. Re-test every prop against EVERY painted way and drop the
  // offenders rather than rendering a lamp post in the middle of a street.
  const clear = props.filter((p) => nearestTarmac(p.x, p.z, roads, ROAD_STYLE, toWorld) > 0.05)
  return clear
}
