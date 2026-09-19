// Crosshair: mouse-following reticle for on-foot weapon aiming.
// DOM overlay (mounted by MenuRoot next to Hud) — writes the mouse position
// into the shared aim module (no React re-render per mousemove: the div is
// moved imperatively via transform). WeaponController reads the same NDC to
// build its camera ray, so bullets land where the cursor points.
// While PLAYING with a gun out the OS cursor is hidden (body class) and this
// reticle IS the cursor.
import React, { useEffect, useRef, useState } from 'react'
import useGameStore, { Phase } from '../store/useGameStore'
import { mouseAim, updateMouseAim } from '../lib/aim'

const Crosshair = () => {
  const phase = useGameStore((s) => s.phase)
  const equipped = useGameStore((s) => s.equipped)
  const inventoryOpen = useGameStore((s) => s.inventoryOpen)
  const driving = useGameStore((s) => s.driving)
  const weaponChangeLeft = useGameStore((s) => s.weaponChangeLeft)
  const [hitJustNow, setHitJustNow] = useState(false)
  const swapRef = useRef(null)
  const lastHitsRef = useRef(0)

  const visible =
    phase === Phase.PLAYING &&
    driving === null &&
    equipped && equipped !== 'fists' &&
    inventoryOpen === false

  // Track the mouse: cheap imperative move + shared NDC for the fire path.
  useEffect(() => {
    if (phase !== Phase.PLAYING) return undefined
    const onMove = (e) => {
      updateMouseAim(e.clientX, e.clientY)
      const el = swapRef.current
      if (el) el.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => window.removeEventListener('mousemove', onMove)
  }, [phase])

  // Snap to the last known position on mount / weapon pickup (no jump from center).
  useEffect(() => {
    const el = swapRef.current
    if (el && mouseAim.has) {
      el.style.transform = `translate(${mouseAim.px}px, ${mouseAim.py}px) translate(-50%, -50%)`
    }
  }, [visible])

  // Hide the OS cursor while the reticle is live (menus keep theirs).
  useEffect(() => {
    if (visible) document.body.classList.add('gt-hide-cursor')
    else document.body.classList.remove('gt-hide-cursor')
    return () => document.body.classList.remove('gt-hide-cursor')
  }, [visible])

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
      const hits = (trace && trace.hits) || 0
      if (hits > lastHitsRef.current) {
        lastHitsRef.current = hits
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
    <div ref={swapRef} className="crosshair crosshair-free" data-hit={hitJustNow ? 'hit' : ''}>
      <span className="crosshair-line crosshair-t" />
      <span className="crosshair-line crosshair-b" />
      <span className="crosshair-line crosshair-l" />
      <span className="crosshair-line crosshair-r" />
      <span className="crosshair-dot" />
    </div>
  )
}

export default Crosshair
