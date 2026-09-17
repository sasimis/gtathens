import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'

/**
 * Slow cinematic orbit over the city shown behind the main menu.
 * The angle resets each time the menu opens so the shot is predictable.
 */
const MenuCamera = ({ active }) => {
  const t = useRef(0)
  const { camera } = useThree()

  useEffect(() => {
    if (active) t.current = 0
  }, [active])

  useFrame((state, delta) => {
    if (!active) return
    t.current += delta * 0.055
    const a = t.current
    const r = 340
    state.camera.position.set(Math.cos(a) * r, 210, Math.sin(a) * r)
    state.camera.lookAt(0, 0, 0)
  })

  return null
}

export default MenuCamera
