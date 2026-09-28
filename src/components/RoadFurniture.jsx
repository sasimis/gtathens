import React, { useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { ROAD_STYLE } from '../lib/roadStyle'
import { FURNITURE_MODELS, planRoadFurniture } from '../lib/roadSurface'
import { latToWorldZ, lonToWorldX } from '../lib/geo'

/**
 * Kenney "City Kit (Roads)" street furniture, placed along the REAL OSM ways.
 *
 * This is the half of the Kenney integration that uses the pack's actual
 * MODELS — the road tiles themselves cannot follow a real street network (see
 * lib/roadSurface.js for the measurements), but lamp posts, traffic lights and
 * signs are free-standing props that drop onto a kerb at any angle.
 *
 * The pack is authored at 1 unit = 1 m, so the models are placed UNSCALED
 * (a `traffic-light` is 0.515 m tall, a `light-square` 0.6 m — correct for this
 * world, where the character is 1.8 m). There is no per-instance rescale
 * anywhere in here on purpose.
 *
 * Placement is pure + deterministic (lib/roadSurface.planRoadFurniture), so
 * props do not move between reloads. Every prop is a module-level URL, so the
 * hooks are called in a fixed order and the GLTF cache is shared.
 */

// Kenney ships a single colour atlas per pack; the GLBs reference it by the
// relative URI `Textures/colormap.png`, so the .glb files must sit in a folder
// that has a `Textures/colormap.png` beside them. `public/models/kenney/roads/`
// therefore holds `colormap.png` and a `Textures/` alias folder — see
// scripts/install-kenney-roads.mjs, which creates the alias. A flat layout
// fails at load time with
//   THREE.GLTFLoader: Couldn't load texture Textures/colormap.png
FURNITURE_MODELS.forEach((id) => useGLTF.preload(`/models/kenney/roads/${id}.glb`))

// NOTE: do NOT use `process.env.BASE_URL` here. This runs in the BROWSER, and
// `process` is undefined there — the ReferenceError is thrown while the module
// is evaluating, which unmounts the whole scene and the game never reaches PLAY
// (it reads as "PLAY did nothing", not as a road bug). Use a root-relative
// path, which is what every other asset in this project does.
const urlFor = (id) => `/models/kenney/roads/${id}.glb`

/** Every prop is a metre-scale model standing on the sidewalk, so no scaling. */
const FURNITURE_LAYOUT = FURNITURE_MODELS

const RoadFurniture = ({ roads }) => {
  const props = useMemo(
    () => planRoadFurniture(roads || [], ROAD_STYLE, (n) => ({
      x: lonToWorldX(n.lon),
      z: latToWorldZ(n.lat),
    })),
    [roads],
  )

  // FURNITURE_LAYOUT is a module-level constant, so hook order never changes.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const scenes = FURNITURE_LAYOUT.map((id) => useGLTF(urlFor(id)).scene)

  const byModel = useMemo(() => {
    const m = new Map()
    for (const p of props) {
      if (!m.has(p.model)) m.set(p.model, [])
      m.get(p.model).push(p)
    }
    return m
  }, [props])

  return (
    <group>
      {FURNITURE_LAYOUT.map((id, i) => {
        const list = byModel.get(id)
        if (!list || !list.length) return null
        return list.map((p, k) => (
          // Key on the model + index: the array is a stable plan, and a
          // position-derived key can collide (two OSM ways round to the same
          // centimetre) which drops a reconciler slot.
          <group key={`${id}-${k}`} position={[p.x, 0.02, p.z]} rotation={[0, p.rotY, 0]}>
            <primitive object={scenes[i]} />
          </group>
        ))
      })}
    </group>
  )
}

export default RoadFurniture
