import React, { useMemo } from 'react'
import useGameStore from '../../store/useGameStore'
import { hash } from './buildingPlanner'

export const BuildingLights = ({ buildings }) => {
  const gameTime = useGameStore((s) => s.gameTime ?? 12)

  let darkness = 0
  if (gameTime >= 20 || gameTime < 5) {
    darkness = 1
  } else if (gameTime >= 17 && gameTime < 20) {
    darkness = (gameTime - 17) / 3
  } else if (gameTime >= 5 && gameTime < 8) {
    darkness = 1 - (gameTime - 5) / 3
  }

  const litBuildings = useMemo(() => {
    return buildings
      .map((b, i) => {
        const seed = hash(i * 13 + 42)
        if (seed <= 0.35) return null

        const colors = ['#FFD566', '#FFAA33', '#FFC266', '#FFE082', '#FF9F43']
        const color = colors[Math.floor(hash(i * 7 + 9) * colors.length)]
        const lightY = Math.max(2, b.colH * 0.45)

        return {
          id: i,
          x: b.x,
          z: b.z,
          y: b.y0 + lightY,
          color,
          h: b.colH,
          w: b.w,
          d: b.d,
          seed,
        }
      })
      .filter(Boolean)
  }, [buildings])

  if (darkness <= 0.01) return null

  return (
    <group>
      {litBuildings.map((b) => (
        <group key={b.id} position={[b.x, b.y, b.z]}>
          <pointLight
            color={b.color}
            intensity={darkness * 2.2}
            distance={Math.max(16, Math.min(b.w, b.d) * 1.5)}
            decay={2}
          />
        </group>
      ))}
    </group>
  )
}
