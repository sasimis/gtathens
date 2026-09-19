import React from 'react'
import useGameStore from '../store/useGameStore'

// Minimal HUD: ONE combined clock + cash chip (top-right) + the F prompt.
// Everything else (name, HP, kills, weapon line, street) was removed —
// the minimap + this chip are the whole HUD. Damage chip stays while driving.
const Hud = () => {
  const driving = useGameStore((s) => s.driving)
  const nearCar = useGameStore((s) => s.nearCar)
  const gameTime = useGameStore((s) => s.gameTime ?? 8)
  const money = useGameStore((s) => s.money ?? 0)
  const carDamage = useGameStore((s) => s.carDamage ?? 0)

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

      {/* Crash damage of the car being driven (turns red near 60%+) */}
      {driving !== null && carDamage > 0.005 && (
        <div
          className="hud-chip hud-dmg"
          style={{ color: carDamage > 0.6 ? '#ff5a4e' : '#f5b800' }}
        >
          DMG {Math.min(100, Math.round(carDamage * 100))}%
        </div>
      )}

      {driving === null && nearCar >= 0 && (
        <div className="hud-action">
          <kbd>F</kbd> enter vehicle
        </div>
      )}

    </>
  )
}

export default Hud
