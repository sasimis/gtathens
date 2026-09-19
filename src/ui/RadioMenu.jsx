import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import useGameStore from '../store/useGameStore'
import { RADIO_STATIONS, radioAudio } from '../lib/radio'
import { StationLogo } from '../components/RadioLogos'

// Greek radio station menu with animations and status indicators
const RadioMenu = () => {
  const radioOpen = useGameStore((s) => s.radioOpen)
  const radioStation = useGameStore((s) => s.radioStation)
  const setRadioStation = useGameStore((s) => s.setRadioStation)
  const closeRadioMenu = useGameStore((s) => s.closeRadioMenu)
  const driving = useGameStore((s) => s.driving)
  const drivingAi = useGameStore((s) => s.drivingAi)

  const isDriving = driving !== null || drivingAi !== null

  const [status, setStatus] = useState(radioAudio.status)

  // Listen to radioAudio stream updates (connecting, playing, error)
  useEffect(() => {
    return radioAudio.subscribe(({ status: newStatus }) => {
      setStatus(newStatus)
    })
  }, [])

  // Close menu if player exits car
  useEffect(() => {
    if (!isDriving && radioOpen) {
      closeRadioMenu()
    }
  }, [isDriving, radioOpen, closeRadioMenu])

  // Keyboard navigation inside the Radio menu
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
        const next = (radioStation + 1) % RADIO_STATIONS.length
        setRadioStation(next)
      } else if (e.code === 'ArrowUp' || e.code === 'KeyW' || e.code === 'ArrowLeft' || e.code === 'KeyA') {
        e.preventDefault()
        const prev = (radioStation - 1 + RADIO_STATIONS.length) % RADIO_STATIONS.length
        setRadioStation(prev)
      } else if (e.code.startsWith('Digit')) {
        const digit = parseInt(e.code.replace('Digit', ''), 10)
        if (!isNaN(digit) && digit >= 0 && digit < RADIO_STATIONS.length) {
          e.preventDefault()
          setRadioStation(digit)
        }
      }
    }

    const onWheel = (e) => {
      if (!radioOpen) return
      e.preventDefault()
      if (e.deltaY > 0) {
        const next = (radioStation + 1) % RADIO_STATIONS.length
        setRadioStation(next)
      } else if (e.deltaY < 0) {
        const prev = (radioStation - 1 + RADIO_STATIONS.length) % RADIO_STATIONS.length
        setRadioStation(prev)
      }
    }

    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('wheel', onWheel)
    }
  }, [radioOpen, radioStation, setRadioStation, closeRadioMenu])

  if (!radioOpen || !isDriving) return null

  const activeStation = RADIO_STATIONS[radioStation] || RADIO_STATIONS[0]

  return (
    <AnimatePresence>
      <motion.div
        className="radio-screen"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={closeRadioMenu}
      >
        <motion.div
          className="radio-container"
          
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: -10 }}
          transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header with active station info */}
          <div className="radio-header">
            <div className="radio-title-wrap">
              <span className="radio-title">
                <span className="radio-title-accent">RADIO</span>
              </span>
              <span className="radio-hint">Πάτησε [M] ή ESC για κλείσιμο</span>
            </div>

                      <motion.div
              className="radio-active-chip"
              layout
              transition={{ type: 'spring', damping: 25, stiffness: 250 }}
            >
              <span className="active-logo">
                <StationLogo id={activeStation.id} size={40} />
              </span>
              <div className="active-meta">
                <div className="active-name">{activeStation.name}</div>
                <div className="active-sub">
                  <span>{activeStation.freq}</span>
                  {' • '}
                  <span>{activeStation.genre}</span>
                </div>
              </div>

              {/* Status tag with pulse animation when live */}
              <div className={`radio-status-tag status-${status.toLowerCase()}`}>
                {status === 'PLAYING' && (
                  <motion.span
                    className="status-pulse"
                    animate={{ opacity: [1, 0.4, 1] }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                  />
                )}
                <span className="status-text">
                  {status === 'PLAYING' && '🔴 LIVE'}
                  {status === 'CONNECTING' && '⏳ CONNECTING'}
                  {status === 'ERROR' && '⚠ OFFLINE'}
                  {status === 'OFF' && 'OFF'}
                </span>
              </div>
            </motion.div>
          </div>

          {/* Station grid */}
          <div className="radio-grid">
            {RADIO_STATIONS.map((st, idx) => {
              const isSelected = idx === radioStation
              return (
                <motion.button
                  key={st.id}
                  className={`radio-station-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => setRadioStation(idx)}
                  whileHover={{ scale: 1.02, x: 4 }}
                  transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                >
                  <span className="card-icon">
                    <StationLogo id={st.id} size={28} />
                  </span>
                  <div className="card-info">
                    <span className="card-name">{st.name}</span>
                    <span className="card-freq">{st.freq} • {st.genre}</span>
                  </div>
                  {isSelected && status === 'PLAYING' && (
                    <motion.span
                      className="card-indicator playing"
                      initial={{ scale: 0 }}
                      animate={{ scale: [1, 0.8, 1] }}
                      transition={{ duration: 0.5 }}
                    >
                      ■
                    </motion.span>
                  )}
                  {isSelected && status !== 'PLAYING' && status !== 'OFF' && (
                    <span className="card-indicator connecting">⏳</span>
                  )}
                  {isSelected && (
                    <motion.div
                      className="selected-glow"
                      layoutId="selectedGlow"
                      initial={false}
                    />
                  )}
                </motion.button>
              )
            })}
          </div>

          {/* Footer with instructions */}
          <div className="radio-footer">
            <div className="radio-footer-grid">
              <span className="radio-shortcut">
                <kbd>↑↓</kbd> or <kbd>W/S</kbd> next/prev
              </span>
              <span className="radio-shortcut">
                <kbd>1-9</kbd> quick select
              </span>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

export default RadioMenu
