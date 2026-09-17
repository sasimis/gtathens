import React, { useRef, useMemo, useImperativeHandle, forwardRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const Stars = forwardRef(({ count = 2000, radius = 1800 }, ref) => {
  const pointsRef = useRef()
  useImperativeHandle(ref, () => pointsRef.current, [])

  const [positions, sizes] = useMemo(() => {
    const pos = new Float32Array(count * 3)
    const sz = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(Math.random() * 0.8 + 0.2)
      const r = radius * (0.9 + Math.random() * 0.1)
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.cos(phi)
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
      sz[i] = 1 + Math.random() * 2.5
    }
    return [pos, sz]
  }, [count, radius])

  useFrame(({ clock }) => {
    if (!pointsRef.current) return
    const sizesAttr = pointsRef.current.geometry.getAttribute('size')
    const time = clock.getElapsedTime()
    for (let i = 0; i < count; i++) {
      const twinkle = 0.7 + 0.3 * Math.sin(time * (1 + i * 0.01) + i)
      sizesAttr.array[i] = sizes[i] * twinkle
    }
    sizesAttr.needsUpdate = true
  })

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={positions} itemSize={3} />
        <bufferAttribute attach="attributes-size" count={count} array={sizes} itemSize={1} />
      </bufferGeometry>
      <pointsMaterial size={2} sizeAttenuation color="#ffffff" transparent opacity={0.9} depthWrite={false} />
    </points>
  )
})

Stars.displayName = 'Stars'
export default Stars

