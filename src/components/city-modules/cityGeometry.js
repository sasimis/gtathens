export const xzHull = (points) => {
  const seen = new Set()
  const pts = []
  for (const p of points) {
    const key = `${p[0].toFixed(3)},${p[1].toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    pts.push(p)
  }
  if (pts.length < 3) return null
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (P) => {
    const st = []
    for (const p of P) {
      while (st.length >= 2 && cross(st[st.length - 2], st[st.length - 1], p) <= 1e-9) st.pop()
      st.push(p)
    }
    return st
  }
  const lo = half(pts)
  const up = []
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i]
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 1e-9) up.pop()
    up.push(p)
  }
  lo.pop()
  up.pop()
  const hull = lo.concat(up)
  if (hull.length < 3) return null
  const SIN_MIN = Math.sin((10 * Math.PI) / 180)
  const simple = []
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[(i + hull.length - 1) % hull.length]
    const b = hull[i]
    const c = hull[(i + 1) % hull.length]
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1])
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1])
    if (l1 * l2 < 1e-9) continue
    if (Math.abs(cross(a, b, c)) / (l1 * l2) < SIN_MIN) continue
    simple.push(b)
  }
  return simple.length >= 3 ? simple : hull
}

export const pointToSegmentDistSq = (px, pz, x1, z1, x2, z2) => {
  const dx = x2 - x1
  const dz = z2 - z1
  const L2 = dx * dx + dz * dz
  let t = 0
  if (L2 > 1e-12) {
    t = ((px - x1) * dx + (pz - z1) * dz) / L2
    t = t < 0 ? 0 : t > 1 ? 1 : t
  }
  const cx = x1 + dx * t - px
  const cz = z1 + dz * t - pz
  return cx * cx + cz * cz
}

export const pointToSegmentDist = (px, pz, x1, z1, x2, z2) =>
  Math.sqrt(pointToSegmentDistSq(px, pz, x1, z1, x2, z2))

export const isConvexRing = (ring) => {
  const n = ring.length
  if (n < 3) return true
  let sign = 0
  for (let i = 0; i < n; i += 1) {
    const a = ring[(i + n - 1) % n]
    const b = ring[i]
    const c = ring[(i + 1) % n]
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if (Math.abs(cross) < 1e-9) return false
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

export const pointInTriangle = (p, a, b, c, areaSign) => {
  const v0x = c[0] - a[0], v0y = c[1] - a[1]
  const v1x = b[0] - a[0], v1y = b[1] - a[1]
  const v2x = p[0] - a[0], v2y = p[1] - a[1]
  const dot00 = v0x * v0x + v0y * v0y
  const dot01 = v0x * v1x + v0y * v1y
  const dot02 = v0x * v2x + v0y * v2y
  const dot11 = v1x * v1x + v1y * v1y
  const dot12 = v1x * v2x + v1y * v2y
  const inv = dot00 * dot11 - dot01 * dot01
  if (Math.abs(inv) < 1e-12) return false
  const u = (dot11 * dot02 - dot01 * dot12) / inv
  const v = (dot00 * dot12 - dot01 * dot02) / inv
  return u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9
}

export const triangulateEarclip = (ring) => {
  const pts = ring.map((p) => [p[0], p[1]])
  const n = pts.length
  const idx = new Array(n)
  for (let i = 0; i < n; i += 1) idx[i] = i
  const out = []
  let again = true
  while (again && idx.length > 3) {
    again = false
    for (let k = 0; k < idx.length; k += 1) {
      const i0 = idx[(k + idx.length - 1) % idx.length]
      const i1 = idx[k]
      const i2 = idx[(k + 1) % idx.length]
      const ax = pts[i1][0] - pts[i0][0]
      const ay = pts[i1][1] - pts[i0][1]
      const bx = pts[i2][0] - pts[i1][0]
      const by = pts[i2][1] - pts[i1][1]
      const cross = ax * by - ay * bx
      if (Math.abs(cross) < 1e-9) continue
      const areaSign = Math.sign(cross)
      let ok = true
      for (let j = 0; j < idx.length; j += 1) {
        if (j === k || j === (k + 1) % idx.length) continue
        const p = pts[idx[j]]
        if (pointInTriangle(p, pts[i0], pts[i1], pts[i2], areaSign)) {
          ok = false
          break
        }
      }
      if (!ok) continue
      out.push([i0, i1, i2])
      idx.splice(k, 1)
      again = true
      break
    }
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]])
  return out
}

export const hullVerts = (b) => {
  const h = Math.max(b.colH || b.h || 4, 0.5)
  const ring = []
  for (const [px, pz] of b.footprint || b.outline || []) {
    const lx = px - b.x
    const lz = pz - b.z
    if (!Number.isFinite(lx) || !Number.isFinite(lz)) continue
    const last = ring[ring.length - 1]
    if (last && Math.abs(last[0] - lx) < 1e-3 && Math.abs(last[1] - lz) < 1e-3) continue
    ring.push([lx, lz])
  }
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (ring.length > 1 && Math.abs(first[0] - last[0]) < 1e-3 && Math.abs(first[1] - last[1]) < 1e-3) {
    ring.pop()
  }

  let area2 = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i]
    const c = ring[(i + 1) % ring.length]
    area2 += a[0] * c[1] - c[0] * a[1]
  }
  const usable = ring.length >= 3 && Math.abs(area2) * 0.5 > 0.5
  const hw = Math.max(b.w, 1) / 2
  const hd = Math.max(b.d, 1) / 2
  const base = usable ? ring : [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]

  const concave = usable && !isConvexRing(base)
  if (concave) {
    const tris = triangulateEarclip(base)
    if (tris.length >= 1) {
      const vertCount = tris.length * 6
      const verts = new Float32Array(vertCount * 3)
      let k = 0
      for (const [i0, i1, i2] of tris) {
        const b0 = base[i0], b1 = base[i1], b2 = base[i2]
        for (const [lx, lz] of [b0, b1, b2]) {
          verts[k] = lx; verts[k + 1] = 0; verts[k + 2] = lz; k += 3
        }
        for (const [lx, lz] of [b0, b1, b2]) {
          verts[k] = lx; verts[k + 1] = h; verts[k + 2] = lz; k += 3
        }
      }
      const idxCount = tris.length * 12
      const indices = new Int16Array(idxCount)
      let ik = 0
      for (let t = 0; t < tris.length; t += 1) {
        const baseIdx = t * 6
        const b0 = baseIdx, b1 = baseIdx + 1, b2 = baseIdx + 2
        const t0 = baseIdx + 3, t1 = baseIdx + 4, t2 = baseIdx + 5
        indices[ik] = b0; indices[ik + 1] = b1; indices[ik + 2] = b2; ik += 3
        indices[ik] = t0; indices[ik + 1] = t2; indices[ik + 2] = t1; ik += 3
        indices[ik] = b0; indices[ik + 1] = b1; indices[ik + 2] = t1; ik += 3
        indices[ik] = b0; indices[ik + 1] = t1; indices[ik + 2] = t0; ik += 3

        indices[ik] = b1; indices[ik + 1] = b2; indices[ik + 2] = t2; ik += 3
        indices[ik] = b1; indices[ik + 1] = t2; indices[ik + 2] = t1; ik += 3

        indices[ik] = b2; indices[ik + 1] = b0; indices[ik + 2] = t0; ik += 3
        indices[ik] = b2; indices[ik + 1] = t0; indices[ik + 2] = t2; ik += 3
      }
      return { verts, indices, kind: 'trimesh' }
    }
  }

  const flat = new Float32Array(base.length * 6)
  let k = 0
  for (const [lx, lz] of base) {
    flat[k] = lx
    flat[k + 1] = 0
    flat[k + 2] = lz
    k += 3
  }
  for (const [lx, lz] of base) {
    flat[k] = lx
    flat[k + 1] = h
    flat[k + 2] = lz
    k += 3
  }
  return { verts: flat, kind: 'convex' }
}
