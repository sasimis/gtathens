import React, { useEffect, useMemo, useState } from 'react'
import { Merged } from '@react-three/drei'
import Roads from './Roads'
import useGameStore from '../store/useGameStore'
import { latToWorldZ, lonToWorldX } from '../lib/geo'
import {
  BuildingColliders,
  BuildingLights,
  planBuildings,
  useKenneyMeshes,
} from './city-modules'

const City = () => {
  const [data, setData] = useState(null)
  const setSpawn = useGameStore((s) => s.setSpawn)

  useEffect(() => {
    fetch('/map_data.json')
      .then((res) => res.json())
      .then(setData)
      .catch((err) => console.error('Error loading map data:', err))
  }, [])

  const { meshMap, byModel } = useKenneyMeshes()

  const buildings = useMemo(
    () => (data ? planBuildings(data, byModel) : []),
    [data, byModel],
  )

  useEffect(() => {
    if (!data) return
    let best = null
    let bestDist = Infinity
    for (const road of data.roads) {
      for (const n of road.nodes) {
        const x = lonToWorldX(n.lon)
        const z = latToWorldZ(n.lat)
        const dist = x * x + z * z
        if (dist < bestDist) {
          bestDist = dist
          best = [x, z]
        }
      }
    }
    setSpawn(best ?? [0, 0])
  }, [data, setSpawn])

  return (
    <>
      {data && <Roads roads={data.roads} />}
      {buildings.length > 0 && (
        <>
          <Merged
            meshes={meshMap}
            limit={500}
            castShadow
            receiveShadow
            frustumCulled={false}
          >
            {(M) =>
              buildings.map((b, i) => (
                <group
                  key={i}
                  position={[b.x, b.y0, b.z]}
                  rotation={[0, b.rot, 0]}
                  scale={[b.sx, b.sy, b.sz]}
                >
                  {byModel[b.model].keys.map((key) => {
                    const Part = M[key]
                    return <Part key={key} />
                  })}
                </group>
              ))}
          </Merged>
          <BuildingColliders buildings={buildings} />
          <BuildingLights buildings={buildings} />
        </>
      )}
    </>
  )
}

export * from './city-modules'
export default City
