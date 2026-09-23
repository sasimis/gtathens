import React, { useEffect, useState } from 'react'
import useGameStore from '../store/useGameStore'
import { StationLogo } from '../components/RadioLogos'

// Minimal HUD: ONE combined clock + cash chip (top-right) + the F prompt.
// Everything else (name, HP, kills, weapon line, street) was removed —
// the minimap + this chip are the whole HUD. Damage chip stays while driving.
// Gamepad indicator: subscribes to browser connect/disconnect events AND
// polls 2 Hz while mounting (polling alone misses pads until a button press;
// events alone miss pads connected before mount). Shows 🎮 + short id of the
// CHOSEN drive pad (headset dongles skipped), ⌨️ when nothing usable is
// connected. Title tooltip always carries the full id + slot list.
const PadChip = () => {
  const [pad, setPad] = useState({ count: 0, id: '' })
  useEffect(() => {
    let alive = true
    const read = async () => {
      try {
        const mod = await import('../lib/gamepad.js')
        const best = mod.getDrivePad ? mod.getDrivePad() : null
        const snap = typeof window !== 'undefined' ? window.__gtathensPad : null
        const count = snap ? snap.count : (best ? 1 : 0)
        const id = best ? String(best.id || '') : ''
        if (alive) setPad((s) => (s.count !== count || s.id !== id ? { count: best ? 1 : 0, id } : s))
      } catch {}
    }
    read()
    const id = setInterval(read, 500)
    window.addEventListener('gamepadconnected', read)
    window.addEventListener('gamepaddisconnected', read)
    return () => {
      alive = false
      clearInterval(id)
      window.removeEventListener('gamepadconnected', read)
      window.removeEventListener('gamepaddisconnected', read)
    }
  }, [])
  const label = pad.count > 0 ? '🎮' : '⌨️'
  const short = pad.count > 0 ? ` ${pad.id.slice(0, 18)}` : ''
  let title = pad.count > 0 ? pad.id : 'No usable gamepad (press any pad button)'
  try {
    const snap = typeof window !== 'undefined' ? window.__gtathensPad : null
    if (snap && snap.list && snap.list.length) {
      title = snap.list.map((e, i) => `[${i}] ${e.chosen ? '★' : ' '} ${e.id} (${e.mapping || 'no-mapping'} ${e.axes}a/${e.buttons}b)`).join('\n')
    }
  } catch {}
  return (
    <div className="hud-chip hud-pad" title={title}>
      {label}{short}
    </div>
  )
}

const Hud = () => {
  const driving = useGameStore((s) => s.driving)
  const drivingAi = useGameStore((s) => s.drivingAi)
  const nearCar = useGameStore((s) => s.nearCar)
  const nearAiCar = useGameStore((s) => s.nearAiCar)
  const gameTime = useGameStore((s) => s.gameTime ?? 8)
  const money = useGameStore((s) => s.money ?? 0)
  const carDamage = useGameStore((s) => s.carDamage ?? 0)
  const radioToast = useGameStore((s) => s.radioToast)
  const radioOpen = useGameStore((s) => s.radioOpen)

  const isDriving = driving !== null || drivingAi !== null
  const isNearCar = nearCar >= 0 || nearAiCar >= 0

  const [activeBanner, setActiveBanner] = useState(null)
  const [drivenSpeed, setDrivenSpeed] = useState(0)

  // Speed readout while driving: poll the anim state CarDriver writes every
  // frame (5 Hz DOM update, no store writes per frame).
  useEffect(() => {
    if (!isDriving) { setDrivenSpeed(0); return undefined }
    let alive = true
    const id = setInterval(() => {
      if (!alive) return
      try {
        const st = useGameStore.getState()
        const idx = st.driving
        const anim = typeof window !== 'undefined' ? window.__gtathensCarAnim : null
        const a = anim && anim.spots && idx != null ? anim.spots[idx] : null
        if (a) {
          const v = Math.abs(a.speed || 0)
          setDrivenSpeed((s) => (Math.abs(s - v) > 0.5 ? v : s))
        }
      } catch {}
    }, 200)
    return () => { alive = false; clearInterval(id) }
  }, [isDriving])

  useEffect(() => {
    if (!radioToast) return
    setActiveBanner(radioToast.station)
    const timer = setTimeout(() => {
      setActiveBanner(null)
    }, 3500)
    return () => clearTimeout(timer)
  }, [radioToast])

  const hours = Math.floor(gameTime)
  const minutes = Math.floor((gameTime % 1) * 60)
  const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`

  return (
    <>
      <div className="hud-chip hud-status">
        <span className="hud-status-time">{timeString}</span>
        <span className="hud-status-sep" />
        <span className="hud-status-cash">${money}</span>
      </div>

      {/* GTA-Style Radio Banner when tuned or station changed while driving */}
      {isDriving && activeBanner && !radioOpen && (
        <div className="radio-hud-banner">
          <span className="radio-hud-icon">
            <StationLogo id={activeBanner.id} size={28} />
          </span>
          <div className="radio-hud-meta">
            <span className="radio-hud-title">{activeBanner.name}</span>
            <span className="radio-hud-sub">{activeBanner.freq} • {activeBanner.genre}</span>
          </div>
        </div>
      )}

      {/* Crash damage of the car being driven (turns red near 60%+) */}
      {isDriving && carDamage > 0.005 && (
        <div
          className="hud-chip hud-dmg"
          style={{ color: carDamage > 0.6 ? '#ff5a4e' : '#f5b800' }}
        >
          DMG {Math.min(100, Math.round(carDamage * 100))}%
        </div>
      )}

      {/* Speedometer while driving (km/h from the live anim state) */}
      {isDriving && (
        <div className="hud-chip hud-speed">
          {Math.round(drivenSpeed * 3.6)} km/h
        </div>
      )}

      {/* Gamepad status while driving: event + poll driven, re-renders live.
          Shows the CHOSEN drive pad (headset dongles are skipped). */}
      {isDriving && (
        <PadChip />
      )}

      {/* On foot near car prompt */}
      {!isDriving && isNearCar && (
        <div className="hud-action">
          <kbd>F</kbd> enter vehicle
        </div>
      )}

      {/* Driving radio prompt */}
      {isDriving && !radioOpen && (
        <div className="hud-action hud-radio-hint">
          <kbd>M</kbd> radio
        </div>
      )}
    </>
  )
}

export default Hud
