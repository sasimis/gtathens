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

    const cam = window.__gtathensCam
    if (cam && Number.isFinite(cam.yaw)) {
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

      const cosY = Math.cos(-yaw)
      const sinY = Math.sin(-yaw)

      // Transform world coordinate (x, z) to canvas (x, y)
      const worldToCanvas = (x, z) => {
        const dx = x - px
        const dz = z - pz
        const rx = dx * cosY - dz * sinY
        const ry = dx * sinY + dz * cosY
        return [cX + rx / RADAR_SCALE, cY + ry / RADAR_SCALE]
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
      const compassAngles = [
        { label: 'N', angle: 0, color: '#f5b800' },
        { label: 'E', angle: Math.PI / 2, color: '#e8edf5' },
        { label: 'S', angle: Math.PI, color: '#e8edf5' },
        { label: 'W', angle: -Math.PI / 2, color: '#e8edf5' },
      ]

      ctx.font = 'bold 11px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      for (const marker of compassAngles) {
        // Rotate compass angle relative to camera view yaw
        const a = marker.angle - yaw
        const mx = cX + Math.sin(a) * (MAP_RADIUS - 10)
        const my = cY - Math.cos(a) * (MAP_RADIUS - 10)
        ctx.fillStyle = marker.color
        ctx.fillText(marker.label, mx, my)
      }

      // Player Blip (center arrow pointing UP)
      ctx.fillStyle = '#f5b800'
      ctx.strokeStyle = '#151a22'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cX, cY - 8)
      ctx.lineTo(cX + 6, cY + 6)
      ctx.lineTo(cX, cY + 3)
      ctx.lineTo(cX - 6, cY + 6)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()

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
