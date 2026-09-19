import React, { useEffect, useState } from 'react'
import { Line } from '@react-three/drei'
import { crash } from '../Car'
import { sampleRoute } from '../../lib/RoadPathfinder'
import { AI_ROUTES } from './npcState'
import { findNearestOnRoute } from './aiTrafficUtils'

const CAR_COLORS = ['#c0392b', '#2980b9', '#7f8c8d', '#f39c12', '#27ae60', '#8e44ad', '#1abc9c', '#e67e22']

export const AiTrafficDebug = () => {
  const [showRoutes, setShowRoutes] = useState(false)

  useEffect(() => {
    const handleKey = (e) => {
      if (e.code === 'KeyT' && e.target === document.body) {
        setShowRoutes((v) => !v)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  useEffect(() => {
    window.__gtathensShowAiRoutes = setShowRoutes
    return () => { delete window.__gtathensShowAiRoutes }
  }, [setShowRoutes])

  if (!showRoutes) return null

  return (
    <>
      {AI_ROUTES.map((route, i) => {
        if (!route || route.length < 2) return null
        const points = route.map((p) => [p[0], 0.5, p[1]])
        return (
          <Line
            key={`route-${i}`}
            points={points}
            color={CAR_COLORS[i % CAR_COLORS.length]}
            lineWidth={2}
            transparent
            opacity={0.6}
          />
        )
      })}
      {AI_ROUTES.map((route, i) => {
        if (!route || route.length < 2) return null
        const live = crash.aiLive[i]
        if (!live || !Number.isFinite(live.x)) return null

        const nearest = findNearestOnRoute(route, live.x, live.z)
        if (!nearest) return null

        const routeOut = { x: 0, z: 0, yaw: 0, done: false }
        sampleRoute(route, 0, routeOut)

        return (
          <React.Fragment key={`debug-car-${i}`}>
            <mesh position={[live.x, 0.3, live.z]}>
              <sphereGeometry args={[0.5, 8, 8]} />
              <meshBasicMaterial color={CAR_COLORS[i % CAR_COLORS.length]} />
            </mesh>
            <mesh position={[routeOut.x, 0.3, routeOut.z]}>
              <boxGeometry args={[1, 0.2, 1]} />
              <meshBasicMaterial color={CAR_COLORS[i % CAR_COLORS.length]} opacity={0.5} transparent />
            </mesh>
          </React.Fragment>
        )
      })}
    </>
  )
}
