import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import useGameStore from '../store/useGameStore'
import { RADIO_STATIONS, radioAudio } from '../lib/radio'
import { StationLogo } from '../components/RadioLogos'

const WHEEL_SIZE = 520
const CENTER = WHEEL_SIZE / 2
const OUTER_R = 240
const INNER_R = 125
const LOGO_R = (OUTER_R + INNER_R) / 2

// Helper function to draw an SVG pie arc path
const describeArc = (x, y, innerR, outerR, startAngle, endAngle) => {
  const rad = (deg) => ((deg - 90) * Math.PI) / 180
  const startRad = rad(startAngle)
  const endRad = rad(endAngle)

  const x1 = x + outerR * Math.cos(startRad)
  const y1 = y + outerR * Math.sin(startRad)
  const x2 = x + outerR * Math.cos(endRad)
  const y2 = y + outerR * Math.sin(endRad)

  const x3 = x + innerR * Math.cos(endRad)
  const y3 = y + innerR * Math.sin(endRad)
  const x4 = x + innerR * Math.cos(startRad)
  const y4 = y + innerR * Math.sin(startRad)

  const largeArc = endAngle - startAngle <= 180 ? 0 : 1

  return [
    `M ${x1} ${y1}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ')
}

const RadioMenu = () => {
  const radioOpen = useGameStore((s) => s.radioOpen)
  const radioStation = useGameStore((s) => s.radioStation)
  const setRadioStation = useGameStore((s) => s.setRadioStation)
  const closeRadioMenu = useGameStore((s) => s.closeRadioMenu)
  const driving = useGameStore((s) => s.driving)
  const drivingAi = useGameStore((s) => s.drivingAi)

  const isDriving = driving !== null || drivingAi !== null
  const [status, setStatus] = useState(radioAudio.status)
  const wheelRef = useRef(null)

  // Stream status listener
  useEffect(() => {
    return radioAudio.subscribe(({ status: newStatus }) => {
      setStatus(newStatus)
    })
  }, [])

  // Auto-close on vehicle exit
  useEffect(() => {
    if (!isDriving && radioOpen) {
      closeRadioMenu()
    }
  }, [isDriving, radioOpen, closeRadioMenu])

  // Key navigation & mouse wheel
  useEffect(() => {
    if (!radioOpen) return

    const onKey = (e) => {
      if (e.code === 'KeyM' || e.code === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRadioMenu()
        return
      }

      if (e.code === 'ArrowDown' || e.code === 'KeyS' || e.code === 'ArrowRight' || e.code === 'KeyD') {
        e.preventDefault()
        setRadioStation((radioStation + 1) % RADIO_STATIONS.length)
      } else if (e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'ArrowLeft' || e.code === 'KeyA') {
        e.preventDefault()
        setRadioStation((radioStation - 1 + RADIO_STATIONS.length) % RADIO_STATIONS.length)
      }
    }

    const onWheel = (e) => {
      if (!radioOpen) return
      e.preventDefault()
      if (e.deltaY > 0) {
        setRadioStation((radioStation + 1) % RADIO_STATIONS.length)
      } else if (e.deltaY < 0) {
        setRadioStation((radioStation - 1 + RADIO_STATIONS.length) % RADIO_STATIONS.length)
      }
    }

    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('wheel', onWheel)
    }
  }, [radioOpen, radioStation, setRadioStation, closeRadioMenu])

  // Mouse hover raycast on radial wheel
  const handleMouseMove = (e) => {
    if (!wheelRef.current) return
    const rect = wheelRef.current.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = e.clientX - cx
    const dy = e.clientY - cy
    const dist = Math.hypot(dx, dy)

    if (dist < 40) return // ignore center deadzone

    // Angle in degrees from top (12 o'clock clockwise)
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
    if (deg < 0) deg += 360

    const sliceAngle = 360 / RADIO_STATIONS.length
    const hoverIdx = Math.floor(deg / sliceAngle) % RADIO_STATIONS.length
    if (hoverIdx !== radioStation) {
      setRadioStation(hoverIdx)
    }
  }

  if (!radioOpen || !isDriving) return null

  const activeStation = RADIO_STATIONS[radioStation] || RADIO_STATIONS[0]
  const total = RADIO_STATIONS.length
  const sliceAngle = 360 / total

  return (
    <AnimatePresence>
      <motion.div
        className="radio-screen"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={closeRadioMenu}
      >
        <motion.div
          className="radio-wheel-wrapper"
          initial={{ scale: 0.82, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.82, opacity: 0 }}
          transition={{ type: 'spring', damping: 24, stiffness: 320 }}
          onClick={(e) => e.stopPropagation()}
          onMouseMove={handleMouseMove}
          ref={wheelRef}
        >
          {/* SVG Radial Slices */}
          <svg width={WHEEL_SIZE} height={WHEEL_SIZE} className="radio-wheel-svg">
            <defs>
              <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            {/* Outer dark ring backdrop */}
            <circle cx={CENTER} cy={CENTER} r={OUTER_R + 6} fill="rgba(10, 15, 24, 0.75)" stroke="rgba(255, 255, 255, 0.1)" strokeWidth="2" />

            {/* Radial Sectors */}
            {RADIO_STATIONS.map((st, i) => {
              const startAngle = i * sliceAngle
              const endAngle = (i + 1) * sliceAngle
              const isSelected = i === radioStation
              const pathD = describeArc(CENTER, CENTER, INNER_R, isSelected ? OUTER_R + 8 : OUTER_R, startAngle, endAngle)

              return (
                <path
                  key={st.id}
                  d={pathD}
                  fill={isSelected ? st.color : 'rgba(20, 28, 42, 0.82)'}
                  stroke={isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.12)'}
                  strokeWidth={isSelected ? 3 : 1.5}
                  filter={isSelected ? 'url(#glow)' : undefined}
                  className={`wheel-sector ${isSelected ? 'active' : ''}`}
                  onClick={() => setRadioStation(i)}
                  style={{ cursor: 'pointer', transition: 'all 0.12s ease-out' }}
                />
              )
            })}

            {/* Inner Hub Ring */}
            <circle cx={CENTER} cy={CENTER} r={INNER_R - 2} fill="#0d131f" stroke={activeStation.color || '#f5b800'} strokeWidth="3.5" />
          </svg>

          {/* Logos positioned radially inside slices */}
          <div className="wheel-logos-layer">
            {RADIO_STATIONS.map((st, i) => {
              const midAngle = (i + 0.5) * sliceAngle - 90
              const rad = (midAngle * Math.PI) / 180
              const lx = CENTER + LOGO_R * Math.cos(rad)
              const ly = CENTER + LOGO_R * Math.sin(rad)
              const isSelected = i === radioStation

              return (
                <div
                  key={st.id}
                  className={`wheel-logo-item ${isSelected ? 'selected' : ''}`}
                  style={{
                    left: `${lx}px`,
                    top: `${ly}px`,
                    transform: `translate(-50%, -50%) scale(${isSelected ? 1.25 : 1.0})`,
                  }}
                  onClick={() => setRadioStation(i)}
                >
                  <StationLogo id={st.id} size={isSelected ? 36 : 28} />
                </div>
              )
            })}
          </div>

          {/* Central Information Hub */}
          <div className="wheel-center-hub">
            <div className="hub-logo">
              <StationLogo id={activeStation.id} size={52} />
            </div>
            <div className="hub-title">{activeStation.name}</div>
            <div className="hub-meta">
              <span className="hub-freq">{activeStation.freq}</span>
              <span className="hub-dot">•</span>
              <span className="hub-genre">{activeStation.genre}</span>
            </div>
            <div className={`hub-status status-${status.toLowerCase()}`}>
              {status === 'PLAYING' && '🔴 LIVE'}
              {status === 'CONNECTING' && '⏳ CONNECTING...'}
              {status === 'ERROR' && '⚠️ OFFLINE'}
              {status === 'OFF' && 'OFF'}
            </div>
          </div>
        </motion.div>

        {/* Footer controls guide */}
        <div className="radio-wheel-footer">
          <span>Move mouse / scroll wheel / WASD to select • [M] or ESC to close</span>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

export default RadioMenu
