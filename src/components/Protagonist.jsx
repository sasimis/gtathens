import React, { forwardRef, useEffect, useMemo, useRef } from 'react'
import { useFBX, useTexture, useKeyboardControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import useGameStore from '../store/useGameStore'
import { WEAPONS } from '../lib/weapons'

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

// Scratch quaternions for procedural arm/spine IK posing
const qTarget = new THREE.Quaternion()
const qCurrent = new THREE.Quaternion()
const euler = new THREE.Euler()

const Protagonist = forwardRef(({ action = 'idle', skin = null, animSpeed = 1 }, outerGroup) => {
  const innerRef = useRef(null)
  const model = useFBX('/models/character/protagonist.fbx')
  const skinTex = skin ? useTexture(skin) : null
  const idleFbx = useFBX('/models/character/idle.fbx')
  const runFbx = useFBX('/models/character/run.fbx')
  const jumpFbx = useFBX('/models/character/jump.fbx')

  const equipped = useGameStore((s) => s.equipped)
  const punchAnimT = useRef(0)

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
  const boneRefs = useRef({})

  useEffect(() => {
    const root = innerRef.current
    if (!root || !clips.idle) return
    const mixer = new THREE.AnimationMixer(root)
    mixerRef.current = mixer
    const acts = {}
    for (const [name, clip] of Object.entries(clips)) {
      if (clip) acts[name] = mixer.clipAction(clip)
    }
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
      mixer.uncacheRoot(root)
      mixerRef.current = null
    }
  }, [clips])

  useEffect(() => {
    const acts = actionsRef.current
    const next = acts[action] ?? acts.idle
    if (!next) return
    if (prevAction.current === action) {
      try {
        next.timeScale = action === 'jump' ? 1.1 : animSpeed
      } catch (e) { /* ignore */ }
      return
    }
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

  const scene = useMemo(() => {
    if (!model) return null
    const clone = SkeletonUtils.clone(model)
    clone.scale.setScalar(CHAR_SCALE)
    const bones = {}
    clone.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true
        o.frustumCulled = false
        try {
          if (Array.isArray(o.material)) o.material = o.material.map((m) => (m && m.clone ? m.clone() : m))
          else if (o.material && o.material.clone) o.material = o.material.clone()
        } catch (e) { /* keep shared on failure */ }
      } else if (o.isBone) {
        const lowerName = o.name.toLowerCase()
        if (lowerName.includes('rightshoulder') || lowerName.includes('rightarm')) bones.rightArm = o
        if (lowerName.includes('rightforearm')) bones.rightForearm = o
        if (lowerName.includes('leftshoulder') || lowerName.includes('leftarm')) bones.leftArm = o
        if (lowerName.includes('leftforearm')) bones.leftForearm = o
        if (lowerName.includes('spine') || lowerName.includes('chest')) bones.spine = o
      }
    })
    boneRefs.current = bones
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

  useFrame((_, delta) => {
    const dt = Math.min(Math.max(delta, 0), 0.05)
    if (mixerRef.current) mixerRef.current.update(dt)

    // Procedural weapon arm posing: override upper arm bone rotations after mixer update
    const bones = boneRefs.current
    if (!bones || !equipped) return

    const wdef = WEAPONS[equipped]
    if (equipped === 'fists') {
      // Check for punch attack triggering from window hook
      if (window.__gtathensPunchT && window.__gtathensPunchT > 0) {
        punchAnimT.current = 0.35
        window.__gtathensPunchT = 0
      }
      if (punchAnimT.current > 0) {
        punchAnimT.current = Math.max(0, punchAnimT.current - dt)
        const progress = 1 - (punchAnimT.current / 0.35) // 0 to 1
        const punchSwing = Math.sin(progress * Math.PI) // 0 -> 1 -> 0
        if (bones.rightArm) {
          euler.set(0.6 * punchSwing, -0.4 * punchSwing, -0.8 * punchSwing)
          qTarget.setFromEuler(euler)
          bones.rightArm.quaternion.slerp(qTarget, 0.4)
        }
      }
    } else if (wdef) {
      // Aim / weapon holding pose
      const isTwoHanded = wdef.mag > 20 || wdef.damage > 30 // Rifle / Shotgun
      if (bones.rightArm) {
        euler.set(-0.6, -0.25, 0.1) // Lift right arm forward/up
        qTarget.setFromEuler(euler)
        bones.rightArm.quaternion.slerp(qTarget, 0.25)
      }
      if (bones.leftArm && isTwoHanded) {
        euler.set(-0.5, 0.35, -0.1) // Bring left arm across to support rifle barrel
        qTarget.setFromEuler(euler)
        bones.leftArm.quaternion.slerp(qTarget, 0.25)
      }
    }
  })

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
