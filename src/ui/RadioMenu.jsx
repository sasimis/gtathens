import React, { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import useGameStore from '../store/useGameStore'
import { RADIO_STATIONS, radioAudio } from '../lib/radio'
import { StationLogo } from '../components/RadioLogos'

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
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          transition={{ type: 'spring', damping: 22, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="radio-header">
            <div className="radio-title-wrap">
              <span className="radio-title">GREEK RADIO STATIONS</span>
              <span className="radio-hint">PRESS [M] OR ESC TO CLOSE</span>
            </div>
            <div className="radio-active-chip">
              <span className="active-icon">
                <StationLogo id={activeStation.id} size={36} />
              </span>
              <div className="active-meta">
                <div className="active-name">{activeStation.name}</div>
                <div className="active-sub">
                  <span>{activeStation.freq}</span> • <span>{activeStation.genre}</span>
                </div>
              </div>
              <div className={`radio-status-tag status-${status.toLowerCase()}`}>
                {status === 'PLAYING' && '🔴 LIVE'}
                {status === 'CONNECTING' && '⏳ CONNECTING...'}
                {status === 'ERROR' && '⚠️ OFFLINE'}
                {status === 'OFF' && 'OFF'}
              </div>
            </div>
          </div>

          <div className="radio-grid">
            {RADIO_STATIONS.map((st, idx) => {
              const isSelected = idx === radioStation
              return (
                <button
                  key={st.id}
                  className={`radio-station-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => setRadioStation(idx)}
                >
                  <span className="card-icon">
                    <StationLogo id={st.id} size={30} />
                  </span>
                  <div className="card-info">
                    <span className="card-name">{st.name}</span>
                    <span className="card-freq">{st.freq} • {st.genre}</span>
                  </div>
                  {isSelected && (
                    <span className="card-indicator">◄</span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="radio-footer">
            <span>Scroll wheel or Arrow keys to change station</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

export default RadioMenu
