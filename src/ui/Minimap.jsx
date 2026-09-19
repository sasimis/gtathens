import React, { useEffect, useRef } from 'react'
import useGameStore, { Phase } from '../store/useGameStore'
import { crash } from '../components/car-modules/crashManager'
import { NPC_RECORDS } from '../components/Npcs'

const MAP_RADIUS = 90
const RADAR_SCALE = 1.6 // meters per pixel
const MAP_RANGE = MAP_RADIUS * RADAR_SCALE // max meters visible from center

const getPlayerPosAndYaw = () => {
  let px = 0, pz = 0, yaw = 0
  try {
    const st = useGameStore.getState()
    const driving = st.driving
    const drivingAi = st.drivingAi

    if (drivingAi !== null && drivingAi !== undefined) {
      const g = window.__gtathensCars
      if (g && typeof g.aiPos === 'function') {
        const s = g.aiPos(drivingAi)
        if (s && Number.isFinite(s.x) && Number.isFinite(s.z)) {
          px = s.x
          pz = s.z
        }
      }
    } else if (driving !== null && driving !== undefined) {
      const g = window.__gtathensCars
      if (g && typeof g.pos === 'function') {
        const s = g.pos(driving)
        if (s && Number.isFinite(s.x) && Number.isFinite(s.z)) {
          px = s.x
          pz = s.z
        }
      }
    } else {
      const p = window.__gtathensPlayer
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
        px = p.x
        pz = p.z
        yaw = p.camYaw ?? 0
      }
    }

    // Determine the FORWARD direction of the minimap.
    // We want the arrow to point where the player is GOING, not where the camera
    // compass happens to look.  Prefer the player's actual camera yaw, and only
    // fall back to the harness-spied camera object when the player trace is
    // unavailable (menu/debug quirks).
    try {
      const pl = window.__gtathensPlayer
      if (pl && Number.isFinite(pl.x) && Number.isFinite(pl.z) && Number.isFinite(pl.camYaw)) {
        yaw = pl.camYaw
      }
    } catch { /* ignore */ }

    // Last resort: if even the player trace is missing, obey the camera object.
    const cam = window.__gtathensCam
    if (!Number.isFinite(yaw) && cam && Number.isFinite(cam.yaw)) {
      yaw = cam.yaw
    }
  } catch { /* fallback */ }
  return { px, pz, yaw }
}

const Minimap = () => {
  const canvasRef = useRef(null)
  const phase = useGameStore((s) => s.phase)

  useEffect(() => {
    if (phase !== Phase.PLAYING) return undefined

    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    let animId = 0

    const render = () => {
      const { px, pz, yaw } = getPlayerPosAndYaw()
      const width = canvas.width
      const height = canvas.height
      const cX = width / 2
      const cY = height / 2

      ctx.clearRect(0, 0, width, height)

      // Circular clip path
      ctx.save()
      ctx.beginPath()
      ctx.arc(cX, cY, MAP_RADIUS, 0, Math.PI * 2)
      ctx.clip()

      // Radar background
      const bgGrad = ctx.createRadialGradient(cX, cY, 0, cX, cY, MAP_RADIUS)
      bgGrad.addColorStop(0, 'rgba(12, 18, 28, 0.92)')
      bgGrad.addColorStop(1, 'rgba(6, 10, 18, 0.98)')
      ctx.fillStyle = bgGrad
      ctx.fillRect(0, 0, width, height)

      // Grid rings
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cX, cY, MAP_RADIUS * 0.4, 0, Math.PI * 2)
      ctx.arc(cX, cY, MAP_RADIUS * 0.75, 0, Math.PI * 2)
      ctx.stroke()

      const cosY = Math.cos(yaw)
      const sinY = Math.sin(yaw)

      // Transform world coordinate (x, z) to canvas (canvasX, canvasY)
      // World: north = -Z, east = +X. Camera yaw=0 faces -Z (north).
      // Minimap convention: UP edge = BACK of the screen = -camera-forward.
      // So when you push forward (W), the minimap shows the terrain moving UNDER you
      // toward the bottom edge (canvas +Y), i.e. the map you moved INTO appears at top.
      // = standard top-down minimap: moving forward pushes everything toward -canvasY.
      // Convert: subtract yaw (invert) vs the camera-forward convention.
      const worldToCanvas = (x, z) => {
        const dx = x - px
        const dz = z - pz
        // TOP edge = camera-forward (where you're looking), BOTTOM = camera-back.
        // LEFT = camera-left, RIGHT = camera-right (screen-handed, matches controller aim).
        // camera-forward direction in world: yaw=0 -> (x=0, z=-1).
        // For a world offset (dx, dz): forward amt = dz*cosY - dx*sinY, right amt = dx*cosY + dz*sinY.
        const fwd = dz * cosY - dx * sinY   // camera-forward amount (world + toward top)
        const rhs = dx * cosY + dz * sinY   // camera-right amount (world + toward right)
        // canvasUp = -fwd (world forward -> top of screen -> -canvasY)
        // canvasRight = rhs (world right -> right of screen -> +canvasX)
        const canvasX = cX + rhs
        const canvasY = cY - fwd
        return [canvasX, canvasY]
      }

      // Draw road segments
      const cache = typeof window !== 'undefined' ? window.__gtathensRoadCache : null
      const segs = cache?.segs
      if (segs && segs.length) {
        ctx.lineCap = 'round'
        for (let i = 0; i < segs.length; i += 1) {
          const s = segs[i]
          if (Math.abs(s.ax - px) > MAP_RANGE + 40 && Math.abs(s.bx - px) > MAP_RANGE + 40) continue
          if (Math.abs(s.az - pz) > MAP_RANGE + 40 && Math.abs(s.bz - pz) > MAP_RANGE + 40) continue

          const [p1x, p1y] = worldToCanvas(s.ax, s.az)
          const [p2x, p2y] = worldToCanvas(s.bx, s.bz)

          const roadW = Math.max(3, (s.w || 6) / RADAR_SCALE)

          // Road base (dark tarmac)
          ctx.strokeStyle = '#1e2636'
          ctx.lineWidth = roadW + 2
          ctx.beginPath()
          ctx.moveTo(p1x, p1y)
          ctx.lineTo(p2x, p2y)
          ctx.stroke()

          // Road surface
          ctx.strokeStyle = '#2d384e'
          ctx.lineWidth = roadW
          ctx.beginPath()
          ctx.moveTo(p1x, p1y)
          ctx.lineTo(p2x, p2y)
          ctx.stroke()
        }
      }

      // Draw Parked / Traffic Cars
      try {
        const livePos = crash.livePos
        for (let i = 0; i < livePos.length; i += 1) {
          const c = livePos[i]
          if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue
          if (Math.abs(c.x - px) > MAP_RANGE || Math.abs(c.z - pz) > MAP_RANGE) continue
          const [cx, cy] = worldToCanvas(c.x, c.z)
          ctx.fillStyle = '#60a5fa' // blue dot for parked cars
          ctx.beginPath()
          ctx.arc(cx, cy, 2.5, 0, Math.PI * 2)
          ctx.fill()
        }

        const aiLive = crash.aiLive
        for (let i = 0; i < aiLive.length; i += 1) {
          const c = aiLive[i]
          if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue
          if (Math.abs(c.x - px) > MAP_RANGE || Math.abs(c.z - pz) > MAP_RANGE) continue
          const [cx, cy] = worldToCanvas(c.x, c.z)
          ctx.fillStyle = '#f87171' // red dot for AI traffic
          ctx.beginPath()
          ctx.arc(cx, cy, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      } catch { /* ignore */ }

      // Draw Pedestrians
      try {
        for (let i = 0; i < NPC_RECORDS.length; i += 1) {
          const r = NPC_RECORDS[i]
          if (!r || r.dead || !r.rb || typeof r.rb.translation !== 'function') continue
          const t = r.rb.translation()
          if (Math.abs(t.x - px) > MAP_RANGE || Math.abs(t.z - pz) > MAP_RANGE) continue
          const [cx, cy] = worldToCanvas(t.x, t.z)
          ctx.fillStyle = '#fef08a' // yellow dot for peds
          ctx.beginPath()
          ctx.arc(cx, cy, 1.8, 0, Math.PI * 2)
          ctx.fill()
        }
      } catch { /* ignore */ }

      ctx.restore() // Restore circular clip

      // Outer compass border ring
      ctx.lineWidth = 3
      ctx.strokeStyle = 'rgba(245, 184, 0, 0.85)'
      ctx.beginPath()
      ctx.arc(cX, cY, MAP_RADIUS, 0, Math.PI * 2)
      ctx.stroke()

      // Glassmorphism overlay ring
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
      ctx.beginPath()
      ctx.arc(cX, cY, MAP_RADIUS - 2, 0, Math.PI * 2)
      ctx.stroke()

      // Compass Cardinal direction markers (N, S, E, W)
      const compassPoints = [
        { label: 'N', dx: 0, dz: -1, color: '#f5b800' },
        { label: 'E', dx: 1, dz: 0, color: '#e8edf5' },
        { label: 'S', dx: 0, dz: 1, color: '#e8edf5' },
        { label: 'W', dx: -1, dz: 0, color: '#e8edf5' },
      ]

      ctx.font = 'bold 11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      const R = MAP_RADIUS - 10
      for (const pt of compassPoints) {
        // Same convention as worldToCanvas: top = camera-forward, right = camera-right.
        const fwd = pt.dz * cosY - pt.dx * sinY
        const rhs = pt.dx * cosY + pt.dz * sinY
        const len = Math.hypot(fwd, rhs) || 1
        const mx = cX + (rhs / len) * R
        const my = cY - (fwd / len) * R
        ctx.fillStyle = pt.color
        ctx.fillText(pt.label, mx, my)
      }

      // Player facing indicator.
      // The arrow points in the direction the vehicle/player is facing on the map.
      // We draw it in minimap-local space where +canvasX = map-right and +canvasY = map-down,
      // then rotate it around the center so the tip tracks the current yaw.
      ctx.save()
      ctx.translate(cX, cY)
      ctx.rotate(yaw)
      // After rotation, local +Y points toward the vehicle's heading on the minimap.
      ctx.beginPath()
      ctx.moveTo(0, 10)          // tip = heading
      ctx.lineTo(-6, -4)         // left flank
      ctx.lineTo(6, -4)          // right flank
      ctx.closePath()
      ctx.fillStyle = '#f5b800'
      ctx.fill()
      ctx.strokeStyle = '#151a22'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()

      animId = requestAnimationFrame(render)
    }

    animId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animId)
  }, [phase])

  if (phase !== Phase.PLAYING) return null

  return (
    <div className="minimap-container">
      <canvas
        ref={canvasRef}
        width={200}
        height={200}
        className="minimap-canvas"
      />
    </div>
  )
}

export default Minimap
