import React, { forwardRef, useEffect, useMemo, useRef } from 'react'
import { useFBX, useTexture, useKeyboardControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'

const CHAR_SCALE = 1.8 / 376.5

useFBX.preload('/models/character/protagonist.fbx')
useFBX.preload('/models/character/idle.fbx')
useFBX.preload('/models/character/run.fbx')
useFBX.preload('/models/character/jump.fbx')

export const CHARACTERS = [
  { id: 'skater-male', name: 'Dimitri', skin: '/models/character/Skins/skaterMaleA.png' },
  { id: 'skater-female', name: 'Alexia', skin: '/models/character/Skins/skaterFemaleA.png' },
  { id: 'criminal-male', name: 'Vincent', skin: '/models/character/Skins/criminalMaleA.png' },
  { id: 'cyborg-female', name: 'Nova', skin: '/models/character/Skins/cyborgFemaleA.png' },
]
CHARACTERS.forEach((c) => { if (c.skin) useTexture.preload(c.skin) })

const clipTotalKeys = (clip) =>
  (clip.tracks || []).reduce(
    (sum, t) => sum + (t.times ? t.times.length : 0) + (t.values ? t.values.length / 3 : 0),
    0,
  )

function pickLongestTake(fbx) {
  if (!fbx) return null
  const anims = fbx.animations || []
  if (anims.length === 0) return null
  let best = anims[0]
  let bestScore = -1
  for (const clip of anims) {
    const score = clipTotalKeys(clip)
    if (score > bestScore) { bestScore = score; best = clip }
  }
  return best.clone()
}

// Strip root-motion (hip position) tracks so the skeleton animates in place.
// The Kenney run/walk clips translate the hip bone forward - combined with
// physics body movement, the character skates and wobbles. Removing the hip
// .position track lets the physics own translation while legs/arms still move.
function stripRootMotion(clip) {
  if (!clip) return null
  const filtered = clip.tracks.filter((track) => {
    const name = track.name || ''
    if (!name.endsWith('.position')) return true
    const bone = name.split('.')[0].toLowerCase()
    const isRootBone =
      bone === 'hip' || bone === 'hips' || bone === 'root' ||
      bone === 'pelvis' || bone === 'parent' ||
      bone.endsWith('hip') || bone.endsWith('root')
    return !isRootBone
  })
  if (filtered.length === clip.tracks.length) return clip
  const clone = clip.clone()
  clone.tracks = filtered
  return clone
}

const Protagonist = forwardRef(({ action = 'idle', skin = null, animSpeed = 1 }, outerGroup) => {
  const innerRef = useRef(null)
  const model = useFBX('/models/character/protagonist.fbx')
  const skinTex = skin ? useTexture(skin) : null
  const idleFbx = useFBX('/models/character/idle.fbx')
  const runFbx = useFBX('/models/character/run.fbx')
  const jumpFbx = useFBX('/models/character/jump.fbx')

  const clips = useMemo(() => {
    const map = {
      idle: stripRootMotion(pickLongestTake(idleFbx)),
      run: stripRootMotion(pickLongestTake(runFbx)),
      jump: stripRootMotion(pickLongestTake(jumpFbx)),
    }
    for (const key of Object.keys(map)) {
      if (map[key]) map[key].name = key
    }
    return map
  }, [idleFbx, runFbx, jumpFbx])

  const mixerRef = useRef(null)
  const actionsRef = useRef({})
  const prevAction = useRef(null)
  useEffect(() => {
    // Capture the group in the closure: React nulls out refs BEFORE passive
    // effect cleanup runs for a deleted tree, so reading innerRef.current in
    // the cleanup passed `null` to uncacheRoot() and threw
    // "Cannot read properties of null (reading 'uuid')". That error killed the
    // whole <Canvas> (black screen) every time the on-foot Player unmounted —
    // i.e. exactly when you climb into a car.
    const root = innerRef.current
    if (!root || !clips.idle) return
    const mixer = new THREE.AnimationMixer(root)
    mixerRef.current = mixer
    const acts = {}
    for (const [name, clip] of Object.entries(clips)) {
      if (clip) acts[name] = mixer.clipAction(clip)
    }
    // Start in idle at full weight so the very first frame is already posed
    // (no bind-pose/T-pose flash while the FBX streams in).
    if (acts.idle) {
      acts.idle.reset()
      acts.idle.setLoop(THREE.LoopRepeat, Infinity)
      acts.idle.enabled = true
      try {
        acts.idle.fadeIn(0.15).play()
      } catch (e) {
        acts.idle.play()
      }
    }
    prevAction.current = 'idle'
    actionsRef.current = acts
    return () => {
      try {
        mixer.stopAllAction()
      } catch (e) {
        /* ignore */
      }
      // MUST use the captured `root`: React nulls out refs before passive
      // effect cleanup runs for a deleted tree, so reading innerRef.current
      // here handed `null` to uncacheRoot() -> "Cannot read properties of null
      // (reading 'uuid')" -> the throw unmounted the whole <Canvas> (black
      // screen), which is exactly what happened when climbing into a car.
      mixer.uncacheRoot(root)
      mixerRef.current = null
    }
  }, [clips])

  useEffect(() => {
    const acts = actionsRef.current
    const next = acts[action] ?? acts.idle
    if (!next) return
    // Same clip, only the playback speed changed (walk -> run): NEVER reset or
    // re-fade. reset() drops every weight to 0 for one frame, which reads as a
    // T-pose flash. Just retime the already-playing action.
    if (prevAction.current === action) {
      try {
        next.timeScale = action === 'jump' ? 1.1 : animSpeed
      } catch (e) { /* ignore */ }
      return
    }
    // Real clip switch: overlap the blends so at least one pose stays at
    // weight ~1 the whole time (no bind-pose gap). Fade the winner in FIRST,
    // then fade the losers out — a single frame with no weight-1 pose reads
    // as arms-out (T-pose).
    try {
      next.reset()
    } catch (e) {
      /* ignore */
    }
    next.setLoop(THREE.LoopRepeat, Infinity)
    next.clampWhenFinished = false
    next.timeScale = action === 'jump' ? 1.1 : animSpeed
    next.enabled = true
    try {
      next.fadeIn(0.2).play()
    } catch (e) {
      next.play()
    }
    for (const [name, a] of Object.entries(acts)) {
      if (a === next) continue
      try {
        a.fadeOut(0.2)
      } catch (e) {
        /* ignore */
      }
    }
    prevAction.current = action
  }, [action, animSpeed])

  useFrame((_, delta) => {
    // Clamp the step so a hitch never fast-forwards the skeleton (pop), and
    // keep ticking a touch after tab-switch so the pose never freezes mid-air.
    if (mixerRef.current) mixerRef.current.update(Math.min(Math.max(delta, 0), 0.05))
  })

  const scene = useMemo(() => {
    if (!model) return null
    const clone = SkeletonUtils.clone(model)
    clone.scale.setScalar(CHAR_SCALE)
    clone.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.frustumCulled = false
        // Clone materials per instance: the FBX cache shares materials across
        // every Protagonist. Mutating m.map for the player's skin would leak
        // onto every NPC (and vice versa) — the "NPC changes skin with me" bug.
        try {
          if (Array.isArray(o.material)) o.material = o.material.map((m) => (m && m.clone ? m.clone() : m))
          else if (o.material && o.material.clone) o.material = o.material.clone()
        } catch (e) { /* keep shared on failure */ }
      }
    })
    return clone
  }, [model])

  useEffect(() => {
    const tex = skinTex
    if (!tex || !scene) return
    scene.traverse((o) => {
      if (!o.isMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        if (!m || !m.isMaterial) continue
        m.map = tex
        if (m.color && typeof m.color.setRGB === 'function') m.color.setRGB(1, 1, 1)
        if (typeof m.needsUpdate !== 'undefined') m.needsUpdate = true
      }
    })
  }, [scene, skinTex])

  if (!scene) return null

  return (
    <group ref={outerGroup}>
      <group ref={innerRef}>
        <primitive object={scene} />
      </group>
    </group>
  )
})

Protagonist.displayName = 'Protagonist'

export function useCharacterAction(bodyRef) {
  const [action, setAction] = React.useState('idle')
  const [animSpeed, setAnimSpeed] = React.useState(1)
  const [, getKeys] = useKeyboardControls()
  const vel = useMemo(() => new THREE.Vector3(), [])

  useFrame(() => {
    const body = bodyRef.current
    if (!body || typeof body.linvel !== 'function') return

    const keys = getKeys()
    const v = body.linvel()
    vel.set(v.x, v.y, v.z)

    const yVel = vel.y
    const xzSpeed = Math.hypot(vel.x, vel.z)

    const isMoving = keys.forward || keys.backward || keys.left || keys.right
    const isSprinting = keys.run && isMoving
    const isGrounded = Math.abs(yVel) < 0.8
    const isJumping = yVel > 2.0

    let next = 'idle'
    let speed = 1

    if (!isGrounded || isJumping) {
      next = 'jump'
      speed = 1.1
    } else if (isMoving) {
      next = 'run'
      speed = isSprinting ? 1.4 : 0.75
    } else {
      next = 'idle'
      speed = 1
    }

    setAction((prev) => (prev !== next ? next : prev))
    setAnimSpeed((prev) => (prev !== speed ? speed : prev))
  })

  return { action, animSpeed }
}

export default Protagonist
