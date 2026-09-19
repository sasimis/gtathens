import { buildRoadGraph, buildSegments, DRIVABLE, hash01 } from '../../lib/worldData'
import { getRoadPathfinder, polylineLength, sampleRoute } from '../../lib/RoadPathfinder'
import { AI_CAR_RADIUS, AI_ROUTES } from './npcState'

export const buildAiRoutes = (data, spawn, count) => {
  let pf = null
  try {
    pf = getRoadPathfinder(data, 'drivable')
  } catch (e) {
    pf = null
  }
  if (pf && pf.size > 4) {
    const routes = []
    for (let k = 0; k < count; k += 1) {
      const r = pf.randomRoute(k * 977 + 13)
      if (r && r.points.length >= 3) routes.push(r.points)
    }
    if (routes.length > 0) {
      AI_ROUTES.length = 0
      for (const r of routes) AI_ROUTES.push(r)
      return routes
    }
  }
  return buildAiRoutesLegacy(data, spawn, count)
}

export const buildAiRoutesLegacy = (data, spawn, count) => {
  const segs = buildSegments(data, (t) => DRIVABLE.has(t))
  const near = segs.filter((s) => {
    const mx = (s.ax + s.bx) / 2
    const mz = (s.az + s.bz) / 2
    const d = Math.hypot(mx - spawn[0], mz - spawn[1])
    return d > 15 && d < AI_CAR_RADIUS
  })
  if (near.length === 0) return []
  const graph = buildRoadGraph(near)
  const nodeList = Array.from(graph.nodes.values())
  const starts = nodeList.filter((n) => {
    const d = Math.hypot(n.x - spawn[0], n.z - spawn[1])
    return d > 15 && d < AI_CAR_RADIUS
  })
  if (starts.length === 0) return []
  const routes = []
  for (let k = 0; k < count; k += 1) {
    const start = starts[Math.floor(hash01(k * 131 + 7) * starts.length) % starts.length]
    const pts = [[start.x, start.z]]
    let prev = null
    let node = start
    let prevDir = null
    for (let step = 0; step < 10; step += 1) {
      if (!node.adj || node.adj.length === 0) break
      let options = node.adj.filter((e) => e.to !== prev)
      if (options.length === 0) options = node.adj.slice()
      let next = options[0].to
      if (prevDir && options.length > 1) {
        let bestScore = -Infinity
        for (const e of options) {
          const dx = e.to.x - node.x
          const dz = e.to.z - node.z
          const len = Math.hypot(dx, dz) || 1
          const score = (dx / len) * prevDir[0] + (dz / len) * prevDir[1]
            + hash01(k * 977 + step * 61 + e.to.x) * 0.35
          if (score > bestScore) {
            bestScore = score
            next = e.to
          }
        }
      } else {
        const pick = Math.floor(hash01(k * 977 + step * 61) * options.length) % options.length
        next = options[pick].to
      }
      const dx = next.x - node.x
      const dz = next.z - node.z
      const len = Math.hypot(dx, dz) || 1
      prevDir = [dx / len, dz / len]
      prev = node
      node = next
      pts.push([node.x, node.z])
      if (pts.length > 4 && Math.hypot(node.x - start.x, node.z - start.z) < 12) break
    }
    if (pts.length < 2) continue
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) > 1) pts.push([first[0], first[1]])
    routes.push(pts)
  }
  return routes
}

export const findNearestOnRoute = (route, x, z) => {
  if (!route || route.length < 2) return null
  const totalLen = polylineLength(route)
  if (totalLen < 0.001) return null

  let bestDist = Infinity
  let bestT = 0
  let bestPoint = route[0]

  const steps = Math.min(route.length * 2, 40)
  for (let i = 0; i <= steps; i += 1) {
    const s = (i / steps) * totalLen
    const out = { x: 0, z: 0, yaw: 0, done: false }
    sampleRoute(route, s, out)
    const dx = out.x - x
    const dz = out.z - z
    const d = dx * dx + dz * dz
    if (d < bestDist) {
      bestDist = d
      bestT = s
      bestPoint = [out.x, out.z]
    }
  }

  return {
    point: bestPoint,
    dist: Math.sqrt(bestDist),
    t: bestT,
    totalLen,
  }
}

export const getLookAheadTarget = (route, progress, lookAheadDist, totalLen) => {
  const targetS = Math.min(progress + lookAheadDist, totalLen)
  const out = { x: 0, z: 0, yaw: 0, done: false }
  sampleRoute(route, targetS, out)
  return {
    x: out.x,
    z: out.z,
    yaw: out.yaw,
    dist: Math.min(lookAheadDist, totalLen - progress),
  }
}

export const isDirectionBlocked = (x, z, yaw, side, others, index, checkDist) => {
  const testX = x + Math.sin(yaw + side * 0.4) * checkDist
  const testZ = z + Math.cos(yaw + side * 0.4) * checkDist

  for (let j = 0; j < others.length; j += 1) {
    if (j === index) continue
    const o = others[j]
    if (!o || !Number.isFinite(o.x)) continue
    if (Math.hypot(testX - o.x, testZ - o.z) < 2.5) {
      return true
    }
  }
  return false
}

export const computeAvoidSteer = (x, z, yaw, speed, others, index, route, aiAvoidDist = 7) => {
  let avoidX = 0
  let avoidZ = 0
  let imminentCollision = false

  for (let k = 0; k < others.length; k += 1) {
    if (k === index) continue
    const o = others[k]
    if (!o || !Number.isFinite(o.x) || !Number.isFinite(o.z)) continue

    const odx = o.x - x
    const odz = o.z - z
    const od = Math.hypot(odx, odz)

    const cosY = Math.cos(-yaw)
    const sinY = Math.sin(-yaw)
    const localX = odx * cosY - odz * sinY
    const localZ = odx * sinY + odz * cosY

    if (localZ < aiAvoidDist && localZ > -4 && Math.abs(localX) < 4) {
      const urgency = Math.max(0, 1 - od / aiAvoidDist)
      const side = localX > 0 ? -1 : 1

      const testAngle = side * 0.5
      const testX = x + Math.sin(yaw + testAngle) * 6
      const testZ = z + Math.cos(yaw + testAngle) * 6

      let canSteer = true
      for (let j = 0; j < others.length; j += 1) {
        if (j === index || j === k) continue
        const oo = others[j]
        if (!oo || !Number.isFinite(oo.x)) continue
        if (Math.hypot(testX - oo.x, testZ - oo.z) < aiAvoidDist * 0.6) {
          canSteer = false
          break
        }
      }

      if (canSteer) {
        avoidX += side * urgency * 0.35
        avoidZ += urgency * 0.15
        imminentCollision = true
      } else {
        avoidZ -= urgency * 0.3
      }
      break
    }

    if (od < aiAvoidDist * 2) {
      const otherYaw = o.yaw || 0
      const odx2 = x - o.x
      const odz2 = z - o.z
      const oLocalX = odx2 * Math.cos(-otherYaw) - odz2 * Math.sin(-otherYaw)
      const oLocalZ = odx2 * Math.sin(-otherYaw) + odz2 * Math.cos(-otherYaw)

      if (oLocalZ < 2 && Math.abs(oLocalX) < 3) {
        const relSpeed = Math.abs(speed + (o.speed || 0)) * 0.5
        const urgency = Math.max(0, 1 - od / (aiAvoidDist * 2))
        if (relSpeed > 1.5) {
          const leftClear = !isDirectionBlocked(x, z, yaw, -1, others, index, aiAvoidDist * 0.8)
          const rightClear = !isDirectionBlocked(x, z, yaw, 1, others, index, aiAvoidDist * 0.8)

          if (leftClear && !rightClear) {
            avoidX -= urgency * 0.2
          } else if (rightClear && !leftClear) {
            avoidX += urgency * 0.2
          } else if (!leftClear && !rightClear) {
            avoidZ -= urgency * 0.4
          }
        }
      }
    }
  }

  return [avoidX, avoidZ, imminentCollision]
}
