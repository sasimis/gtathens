// Shared world-data loader + road-graph helpers.
//
// map_data.json is fetched several times across systems (parking spots in
// Car.jsx has its own long-lived cache; do NOT touch that one). Everything
// NEW (pedestrians, AI traffic, pickups) goes through this module so the JSON
// is fetched exactly once and shared.
//
// World axes: 1 unit = 1 m, north = -Z, east = +X (see lib/geo.js).
import { latToWorldZ, lonToWorldX } from './geo.js'

let cache = null
let pending = null

/** Fetches map_data.json once; every caller awaits the same promise. */
export const loadWorldData = () => {
  if (cache) return Promise.resolve(cache)
  if (!pending) {
    pending = fetch('/map_data.json')
      .then((res) => res.json())
      .then((data) => {
        cache = data
        return data
      })
      .catch((err) => {
        pending = null
        throw err
      })
  }
  return pending
}

// Road types AI cars may drive on (data has no motorway/trunk in this crop).
export const DRIVABLE = new Set([
  'residential',
  'tertiary',
  'secondary',
  'primary',
  'primary_link',
  'living_street',
  'unclassified',
  'service',
])

// Road types pedestrians walk along.
export const WALKABLE = new Set(['footway', 'pedestrian', 'path', 'residential', 'living_street'])

/** Converts one road's OSM nodes to a world-space polyline [[x, z], ...]. */
export const roadPolyline = (road) =>
  (road.nodes || []).map((n) => [lonToWorldX(n.lon), latToWorldZ(n.lat)])

/** Straight segments of roads passing `filter`, as {ax,az,bx,bz,len}. */
export const buildSegments = (data, filter) => {
  const out = []
  for (const road of data.roads || []) {
    if (!filter(road.type)) continue
    const pts = roadPolyline(road)
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [ax, az] = pts[i]
      const [bx, bz] = pts[i + 1]
      const len = Math.hypot(bx - ax, bz - az)
      if (len < 4 || len > 180) continue
      out.push({ ax, az, bx, bz, len })
    }
  }
  return out
}

const nodeKey = (x, z) => `${Math.round(x * 10)},${Math.round(z * 10)}`

/**
 * Node graph over road segments (for AI traffic routing). Nodes are 0.1 m
 * grid keys; two segments sharing an OSM node become connected edges, so a
 * car can pick its next street at every junction.
 * Returns { nodes: Map<key, {x, z, adj: [{to, len}] }>, edgeList: [{a, b, len}] }
 */
export const buildRoadGraph = (segments) => {
  const nodes = new Map()
  const getNode = (x, z) => {
    const k = nodeKey(x, z)
    let n = nodes.get(k)
    if (!n) {
      n = { x, z, key: k, adj: [] }
      nodes.set(k, n)
    }
    return n
  }
  const edgeList = []
  for (const s of segments) {
    const a = getNode(s.ax, s.az)
    const b = getNode(s.bx, s.bz)
    if (a === b) continue
    a.adj.push({ to: b, len: s.len })
    b.adj.push({ to: a, len: s.len })
    edgeList.push({ a, b, len: s.len })
  }
  return { nodes, edgeList }
}

/** Point-in-polygon (ray casting) for building-footprint rejection. */
export const pointInPolygon = (x, z, polygon) => {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i += 1) {
    const xi = polygon[i][0]
    const zi = polygon[i][1]
    const xj = polygon[j][0]
    const zj = polygon[j][1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** Building footprint polygons in world space (for spawn rejection tests). */
export const buildingPolygons = (data) =>
  (data.buildings || [])
    .map((b) => (b.nodes || []).map((n) => [lonToWorldX(n.lon), latToWorldZ(n.lat)]))
    .filter((poly) => poly.length >= 3)

/** Grass-area polygons in world space (landuse=grass from OSM). */
export const grassPolygons = (data) =>
  (data.grass || [])
    .map((g) => (g.nodes || []).map((n) => [lonToWorldX(n.lon), latToWorldZ(n.lat)]))
    .filter((poly) => poly.length >= 3)

/** Deterministic pseudo-random in [0, 1) from an integer seed. */
export const hash01 = (i) => {
  let h = (i * 2654435761) >>> 0
  h ^= h >>> 13
  h = (h * 1274126177) >>> 0
  return h / 4294967295
}