import React from 'react'
import useGameStore from '../store/useGameStore'
import { CHARACTERS } from '../components/Protagonist'

// Minimal HUD: character chip + GTA clock + the F-to-enter prompt.
// (Brand chip and camera buttons were removed — camera views are on
// keys 1/2/3 and V, see FollowCamera OrbitInput.)
const Hud = () => {
  const driving = useGameStore((s) => s.driving)
  const nearCar = useGameStore((s) => s.nearCar)
  const character = useGameStore((s) => s.character)
  const gameTime = useGameStore((s) => s.gameTime ?? 8)
  const carDamage = useGameStore((s) => s.carDamage ?? 0)
  const char = CHARACTERS[Math.abs(character) % CHARACTERS.length] ?? CHARACTERS[0]

  const hours = Math.floor(gameTime)
  const minutes = Math.floor((gameTime % 1) * 60)
  const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`

  return (
    <>
      <div className="hud-chip hud-char">{char.name}</div>
      <div className="hud-chip hud-time hud-clock">{timeString}</div>

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
