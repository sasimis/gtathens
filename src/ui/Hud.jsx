import React, { useEffect, useState } from 'react'
import useGameStore from '../store/useGameStore'
import { StationLogo } from '../components/RadioLogos'

// Minimal HUD: ONE combined clock + cash chip (top-right) + the F prompt.
// Everything else (name, HP, kills, weapon line, street) was removed —
// the minimap + this chip are the whole HUD. Damage chip stays while driving.
const Hud = () => {
  const driving = useGameStore((s) => s.driving)
  const drivingAi = useGameStore((s) => s.drivingAi)
  const nearCar = useGameStore((s) => s.nearCar)
  const nearAiCar = useGameStore((s) => s.nearAiCar)
  const gameTime = useGameStore((s) => s.gameTime ?? 8)
  const money = useGameStore((s) => s.money ?? 0)
  const carDamage = useGameStore((s) => s.carDamage ?? 0)
  const radioToast = useGameStore((s) => s.radioToast)
  const radioOpen = useGameStore((s) => s.radioOpen)

  const isDriving = driving !== null || drivingAi !== null
  const isNearCar = nearCar >= 0 || nearAiCar >= 0

  const [activeBanner, setActiveBanner] = useState(null)

  useEffect(() => {
    if (!radioToast) return
    setActiveBanner(radioToast.station)
    const timer = setTimeout(() => {
      setActiveBanner(null)
    }, 3500)
    return () => clearTimeout(timer)
  }, [radioToast])

  const hours = Math.floor(gameTime)
  const minutes = Math.floor((gameTime % 1) * 60)
  const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`

  return (
    <>
      <div className="hud-chip hud-status">
        <span className="hud-status-time">{timeString}</span>
        <span className="hud-status-sep" />
        <span className="hud-status-cash">${money}</span>
      </div>

      {/* GTA-Style Radio Banner when tuned or station changed while driving */}
      {isDriving && activeBanner && !radioOpen && (
        <div className="radio-hud-banner">
          <span className="radio-hud-icon">
            <StationLogo id={activeBanner.id} size={28} />
          </span>
          <div className="radio-hud-meta">
            <span className="radio-hud-title">{activeBanner.name}</span>
            <span className="radio-hud-sub">{activeBanner.freq} • {activeBanner.genre}</span>
          </div>
        </div>
      )}

      {/* Crash damage of the car being driven (turns red near 60%+) */}
      {isDriving && carDamage > 0.005 && (
        <div
          className="hud-chip hud-dmg"
          style={{ color: carDamage > 0.6 ? '#ff5a4e' : '#f5b800' }}
        >
          DMG {Math.min(100, Math.round(carDamage * 100))}%
        </div>
      )}

      {/* On foot near car prompt */}
      {!isDriving && isNearCar && (
        <div className="hud-action">
          <kbd>F</kbd> enter vehicle
        </div>
      )}

      {/* Driving radio prompt */}
      {isDriving && !radioOpen && (
        <div className="hud-action hud-radio-hint">
          <kbd>M</kbd> radio
        </div>
      )}
    </>
  )
}

export default Hud
