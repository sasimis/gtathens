// Crosshair: centered reticle overlay for on-foot weapon aiming.
// DOM overlay (mounted by MenuRoot next to Hud/StreetHUD), visible only
// during PLAYING when the player has a weapon equipped. Reads the same
// store selectors the rest of the HUD uses — no store writes, no 3D scene
// re-renders, minimal paint work by showing/hiding one element.
import React, { useEffect, useRef, useState } from 'react'
import useGameStore, { Phase } from '../store/useGameStore'

const Crosshair = () => {
  const phase = useGameStore((s) => s.phase)
  const equipped = useGameStore((s) => s.equipped)
  const inventoryOpen = useGameStore((s) => s.inventoryOpen)
  const driving = useGameStore((s) => s.driving)
  const reloading = useGameStore((s) => s.reloading)
  const weaponChangeLeft = useGameStore((s) => s.weaponChangeLeft)
  const [visible, setVisible] = useState(false)
  const [hitJustNow, setHitJustNow] = useState(false)
  const swapRef = useRef(null)

  useEffect(() => {
    const show =
      phase === Phase.PLAYING &&
      driving === null &&
      equipped && equipped !== 'fists' &&
      inventoryOpen === false

    setVisible(show)
  }, [phase, driving, equipped, inventoryOpen, reloading])

  useEffect(() => {
    const el = swapRef.current
    if (!el) return
    if (weaponChangeLeft > 0) {
      el.setAttribute('data-swap', 'swapping')
    } else {
      el.removeAttribute('data-swap')
    }
  }, [weaponChangeLeft])

  useEffect(() => {
    // Short-lived hit flash state, driven by the weapon controller's public
    // shot telemetry seam. We poll it at a low rate rather than subscribing
    // per frame, and clear it back to false after a brief window.
    if (phase !== Phase.PLAYING) {
      setHitJustNow(false)
      return
    }
    let timeout = null
    const poll = () => {
      const trace =
        typeof window !== 'undefined' ? window.__gtathensShot : null
      const hit = trace && trace.hits > 0
      if (hit) {
        setHitJustNow(true)
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(() => setHitJustNow(false), 120)
      }
    }
    const timer = setInterval(poll, 80)
    return () => {
      clearInterval(timer)
      if (timeout) clearTimeout(timeout)
    }
  }, [phase])

  if (phase !== Phase.PLAYING) return null
  if (!visible) return null

  return (
    <div ref={swapRef} className="crosshair" data-hit={hitJustNow ? 'hit' : ''}>
      <span className="crosshair-line crosshair-t" />
      <span className="crosshair-line crosshair-b" />
      <span className="crosshair-line crosshair-l" />
      <span className="crosshair-line crosshair-r" />
      <span className="crosshair-dot" />
    </div>
  )
}

export default Crosshair
