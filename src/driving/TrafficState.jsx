// src/driving/TrafficState.jsx
// Shared simulation state for the driving test scene's AI traffic, plus the
// traffic-light plan builder. Split into its own module so it can be imported by
// both TrafficCars (the AI brains) and DrivingScene (the UI overlay / QA hook)
// without a circular dependency.
//
// Design:
//  - TrafficLights are STATIC props derived from the road graph: a graph
//    junction becomes a signalized intersection when edges arrive from >=2
//    distinct way-angles AND degree >= 3. Each such junction gets a 60 s
//    yellow-based cycle (default 30/3/30 green/red split).
//  - Per-car state: lane (0=right, 1=left), stopped (waiting), targetProgress
//    (arc-length to re-join the route after a lane change), whichLight
//    (governing light id or -1).
//  - carAt()/leaderDist() give O(n) lookup (TRAFFIC_COUNT=6, fine at 60 Hz).
import { getRoadPathfinder } from '../lib/RoadPathfinder.js'

// Live copy of the lights plan built by TrafficCars (written after map load).
// TrafficLights (DOM overlay) reads from here; it ignores its `lights` prop
// so it can be mounted before the lights are ready and pick them up once loaded.
const CAR_LIGHTS = []
export const setCarLights = (lights) => { CAR_LIGHTS.length = 0; for (const l of lights) CAR_LIGHTS.push(l) }
export const getCarLights = () => CAR_LIGHTS

// A junction is "signalized" if edges arrive from >=2 distinct headings
// (within a heading tolerance) AND degree >= 3. Rejects T-junctions where all
// arms are collinear (no conflict) and parallel-road stitched pairs.
const SIGNAL_HEADING_TOL = Math.PI / 6 // ~30 deg — perpendicular counts as distinct
const SIGNAL_MIN_DEGREE = 3

const GREEN_MS = 30
const YELLOW_MS = 3
const RED_MS = 30
const CYCLE_LEN_MS = (GREEN_MS + YELLOW_MS + RED_MS) * 1000

const mod = (a, b) => ((a % b) + b) % b

export const buildLightPlan = (data) => {
  const pf = getRoadPathfinder(data, 'drivable')
  if (!pf || pf.size < SIGNAL_MIN_DEGREE) return { pf, lights: [] }
  const nodeArr = pf.nodes ? Array.from(pf.nodes.values()) : pf.nodes
  const edgeArr = pf.edgeList || pf.edges || []
  const byNode = new Map()
  for (const e of edgeArr) {
    const a = nodeArr[e.from]
    const b = nodeArr[e.to]
    if (!a || !b) continue
    const h = Math.atan2(b.x - a.x, b.z - a.z)
    let bucket = byNode.get(e.from)
    if (!bucket) { bucket = { h: [], count: 0 }; byNode.set(e.from, bucket) }
    let placed = false
    for (let k = 0; k < bucket.h.length; k += 1) {
      let d = Math.abs(h - bucket.h[k])
      while (d > Math.PI) d = Math.abs(d - Math.PI * 2)
      if (d < SIGNAL_HEADING_TOL) { placed = true; break }
    }
    if (!placed) { bucket.h.push(h); bucket.count += 1 }
  }
  const lights = []
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  for (const [id, b] of byNode) {
    if (b.count < SIGNAL_MIN_DEGREE) continue
    lights.push({
      id,
      nodeId: id,
      x: nodeArr[id] ? nodeArr[id].x : 0,
      z: nodeArr[id] ? nodeArr[id].z : 0,
      arms: b.count, // number of distinct approaches = phase count
      start: now() + Math.random() * CYCLE_LEN_MS,
    })
  }
  return { pf, lights }
}

/** Phase: 0=green,1=yellow,2=red. */
export const lightState = (light, t) => {
  const elapsed = mod(t - (light && Number.isFinite(light.start) ? light.start : 0), CYCLE_LEN_MS)
  const g = GREEN_MS * 1000
  const y = YELLOW_MS * 1000
  if (elapsed < g) return 0
  if (elapsed < g + y) return 1
  return 2
}

/** Arms (approaches) that have a red / amber signal right now â€” must stop. */
export const shouldStopAtLight = (light, t) => {
  const phase = lightState(light, t)
  if (phase === 0) return false // green
  return true
}

// Per-car state, keyed by AI index. Initialized lazily.
const carState = new Map()
export const initCarState = (index) => {
  if (!carState.has(index)) carState.set(index, {
    lane: index % 2,      // 50/50 right/left split per car
    stopped: false,       // waiting on a red / leader
    stoppedT: 0,          // ms spent stopped (for timeout recovery)
    targetProgress: -1,   // arc-length to resume on after a lane change
    whichLight: -1,       // governing light id, or -1
  })
  return carState.get(index)
}
// Read-only accessor (no lazy init) — callers treat a miss as "not spawned yet".
export const getCarState = (index) => carState.get(index)
// Fresh AI state on a TrafficCars (re)mount: drop every per-car record so lane,
// stopped flags and lane-change targets restart clean instead of inheriting
// the previous run's.
export const clearTraffic = () => { carState.clear() }
export const getNearestLight = (lights, x, z, radius = 24) => {
  let best = null
  let bestD = radius * radius
  for (const l of lights) {
    const d = (l.x - x) * (l.x - x) + (l.z - z) * (l.z - z)
    if (d < bestD) { bestD = d; best = l }
  }
  return best
}

// Lane management: cars start on index%2 lane; laneChange() switches them
// toward the opposite side at signalized junctions, but only when clear.
const LANE_RIGHT = 2.2
const LANE_LEFT = -1.8
const LANE_CHANGE_MIN_DIST = 13  // don't lane-change if any car this close

export const laneChange = (car, index, lights, x, z, yaw, speed, route, progress, totalLen) => {
  const st = getCarState(index)
  if (!st) return false
  // Idle / far-from-route / stopped cars don't lane-change.
  if (speed < 0.4 || Math.hypot(x - car.x, z - car.z) > 24) return false
  if (st.stopped) return false
  const curLane = st.lane
  const wantLane = curLane === 0 ? 1 : 0
  if (wantLane === curLane) return false
  // Only lane-change when near a signalized junction (so the swap is spatially
  // sensible and visible — not mid-block random drift).
  let nearJunction = false
  for (const l of lights) {
    const d = (l.x - x) * (l.x - x) + (l.z - z) * (l.z - z)
    if (d < 18 * 18) { nearJunction = true; break }
  }
  if (!nearJunction) return false
  // Safety: no other car within LANE_CHANGE_MIN_DIST (trade-paint check).
  for (const idx2 of carState.keys()) {
    if (idx2 === index) continue
    const c = crash.aiLive[idx2]
    if (!c || !Number.isFinite(c.x)) continue
    if (Math.hypot(c.x - x, c.z - z) < LANE_CHANGE_MIN_DIST) return false
  }
  // Safe: switch lane and mark targetProgress so the next steering sample uses
  // the new lane offset immediately (targetProgress == progress means "re-sample
  // here with new lane").
  st.lane = wantLane
  st.targetProgress = progress
  return true
}

// ----- TrafficLights DOM overlay (SVG-style, mounted OUTSIDE <Canvas>) -----
// IMPORTANT: this is a DOM component. It must NOT be placed inside the R3F
// <Canvas> subtree (that throws "Div is not part of the THREE namespace").
// DrivingScene mounts it as a sibling of <Canvas> in the scene wrapper.
import React, { useEffect, useState } from 'react'

const GREEN = '#2ecc71'
const YELLOW = '#f39c12'
const RED = '#e74c3c'
const STATUS = ['green', 'yellow', 'red']

export const TrafficLights = ({ lights }) => {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'KeyL' && e.target === document.body) setShow((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!show) return null
  const live = getCarLights()
  if (!live || live.length === 0) return null

  const t = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const rows = live.map((l) => {
    const phase = lightState(l, t)
    const color = phase === 0 ? GREEN : phase === 1 ? YELLOW : RED
    const status = STATUS[phase]
    const nextPhase = phase === 0 ? 'yellow' : phase === 1 ? 'red' : 'green'
    const rem = Math.max(0, (CYCLE_LEN_MS - mod(t - l.start, CYCLE_LEN_MS)) / 1000)
    return (
      <div key={l.id} style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 'bold', color: '#7dff9a', width: 60 }}>
            {String(l.id).padStart(2, '0')}
          </span>
          <span style={{ color, fontSize: 14 }}>●</span>
        </div>
        <div style={{ fontSize: 11, color: '#9be87a', paddingLeft: 16, marginTop: 2 }}>
          arms {l.arms} · {status} · next {nextPhase} · in {rem.toFixed(1)}s
        </div>
      </div>
    )
  })

  return (
    <div
      style={{
        position: 'fixed',
        top: '56px',
        left: '8px',
        background: 'rgba(0,18,14,0.78)',
        color: '#9be87a',
        padding: '10px 12px',
        border: '1px solid #0f4f2a',
        borderRadius: 6,
        fontSize: '12px',
        fontFamily: "'Courier New', monospace",
        zIndex: 50,
        pointerEvents: 'none',
        minWidth: 170,
        maxWidth: 240,
      }}
    >
      <div style={{ color: '#ffd700', fontWeight: 'bold', marginBottom: 8, fontSize: 13 }}>
        🚦 LIGHTS <span style={{ float: 'right', color: '#7dff9a', fontSize: 11 }}>[L]</span>
      </div>
      {rows}
      {lights.length === 0 && <div style={{ color: '#7dff9a', padding: 4 }}>no signalized intersections</div>}
    </div>
  )
}

// ----- Headless QA seam (same pattern as __gtathensCars / __gtathensPlayer) -----
const trafficQA = {
  aiLive: () => crash.aiLive,
  aiBodies: () => crash.aiBodies,
  getCarState: (i) => getCarState(i),
  lights: () => CAR_LIGHTS.slice(),
  lightCount: () => CAR_LIGHTS.length,
}
if (typeof window !== 'undefined') window.__gtathensTraffic = trafficQA

