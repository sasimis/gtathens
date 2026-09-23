// Shared gamepad helpers (W3C Standard mapping).
export const GP_DEADZONE = 0.18

// Separate, tighter deadzone for driving sticks — steering needs precision
// around center while on-foot movement wants the forgiving default.
export const GP_DEADZONE_DRIVE = 0.08

// Curve applied to driving sticks/triggers after the deadzone: expo keeps
// small corrections precise and still reaches full lock at the edges.
export const driveCurve = (v, expo = 1.6) => {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  const s = Math.sign(v)
  const a = Math.min(1, Math.abs(v))
  return s * Math.pow(a, expo)
}

export const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  LS: 10,
  RS: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
}

export const applyDeadzone = (v, dz = GP_DEADZONE) => {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  if (Math.abs(v) < dz) return 0
  return (v - Math.sign(v) * dz) / (1 - dz)
}

// Gamepad connection state: event-driven (gamepadconnected /
// gamepaddisconnected fire exactly once per connect, unlike polling which
// only sees the pad after a button press). Published to window.__gtathensPad
// so the HUD + console always show the live state.
const padEvents = { seen: false }
if (typeof window !== 'undefined' && !padEvents.seen) {
  padEvents.seen = true
  try {
    window.addEventListener('gamepadconnected', (e) => {
      try {
        const snap = window.__gtathensPad || (window.__gtathensPad = { count: 0, id: '', axes: 0, buttons: 0, event: '' })
        snap.event = `connected:${e?.gamepad?.id || ''}`
        snap.count = 1
        snap.id = String(e?.gamepad?.id || '')
        snap.axes = e?.gamepad?.axes ? e.gamepad.axes.length : 0
        snap.buttons = e?.gamepad?.buttons ? e.gamepad.buttons.length : 0
      } catch {}
    })
    window.addEventListener('gamepaddisconnected', (e) => {
      try {
        const snap = window.__gtathensPad || (window.__gtathensPad = { count: 0, id: '', axes: 0, buttons: 0, event: '' })
        snap.event = `disconnected:${e?.gamepad?.id || ''}`
        snap.count = 0
      } catch {}
    })
  } catch {}
}

/** Devices that expose a Gamepad-API endpoint but are NOT controllers:
 * USB headsets / dongles / HID audio (e.g. "Jabra LINK 260") appear in
 * navigator.getGamepads() with a couple of buttons and no real axes, and
 * because they sit at slot 0 a naive "first connected pad" pick drives the
 * car with a headset — inputs do nothing. Skipped unless the pad reports
 * the W3C "standard" mapping (real controllers do; HID audio never does). */
const PAD_SKIP_RE = /(jabra|link\s*260|headset|headphone|airpods|plantronics|poly\s|speaker|microphone|webcam|keyboard|mouse|touchpad)/i

const scorePad = (p) => {
  if (!p) return -1e9
  let s = 0
  try {
    if (p.mapping === 'standard') s += 100
    const axes = p.axes ? p.axes.length : 0
    const btns = p.buttons ? p.buttons.length : 0
    if (axes >= 2) s += 10
    if (axes >= 4) s += 10
    if (btns >= 8) s += 10
    if (btns >= 12) s += 10
    // A pad with SOME live input outranks a silent one (headsets idle at 0).
    let live = 0
    for (let i = 0; i < Math.min(4, axes); i += 1) {
      if (Math.abs(p.axes[i] || 0) > 0.2) { live += 5; break }
    }
    for (let i = 0; i < Math.min(btns, 17); i += 1) {
      const b = p.buttons[i]
      if (b && (b.pressed || (typeof b.value === 'number' && b.value > 0.3))) { live += 5; break }
    }
    s += live
    const id = String(p.id || '')
    if (PAD_SKIP_RE.test(id) && p.mapping !== 'standard') s -= 1000
  } catch {}
  return s
}

/** Manual override for diagnosis: set window.__gtathensPadIdx = 2 in the
 * console to force-drive with that slot, or -1 to clear. */
const padOverride = () => {
  try {
    const v = typeof window !== 'undefined' ? window.__gtathensPadIdx : null
    if (Number.isInteger(v) && v >= 0) return v
  } catch {}
  return -1
}

/** Best controller for driving: highest scorePad() wins, so a real
 * standard-mapping pad always beats a headset dongle in slot 0. Returns
 * null when nothing usable is connected. */
export const getDrivePad = () => {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null
  try {
    const pads = navigator.getGamepads()
    const ov = padOverride()
    if (ov >= 0 && pads[ov] && pads[ov].connected) return pads[ov]
    let best = null
    let bestScore = -1e9
    for (const p of pads) {
      if (!p || !p.connected) continue
      const s = scorePad(p)
      if (s > bestScore) { bestScore = s; best = p }
    }
    // A deeply negative score means "only HID audio here" — report no pad
    // so the HUD shows ⌨️ instead of a fake 🎮 that can never drive.
    if (best && bestScore < -500) best = null
    try {
      if (typeof window !== 'undefined') {
        const snap = window.__gtathensPad || (window.__gtathensPad = { count: 0, id: '', axes: 0, buttons: 0, event: '', list: [] })
        let count = 0
        const list = []
        for (const p of pads) {
          if (!p || !p.connected) continue
          count += 1
          list.push({ id: String(p.id || ''), mapping: p.mapping || '', axes: p.axes ? p.axes.length : 0, buttons: p.buttons ? p.buttons.length : 0, chosen: p === best })
        }
        snap.count = count
        snap.list = list
        snap.id = best ? String(best.id || '') : ''
        snap.axes = best ? (best.axes ? best.axes.length : 0) : 0
        snap.buttons = best ? (best.buttons ? best.buttons.length : 0) : 0
      }
    } catch {}
    return best
  } catch (e) {
    return null
  }
}

/** First usable controller, or null. Kept for menus/on-foot systems: same
 * headset-aware pick as getDrivePad (driving input reads getDrivePad). */
export const getGamepad = () => getDrivePad()

/** Deadzoned stick axis value in [-1, 1]. */
export const readStick = (pad, axis, dz = GP_DEADZONE) => applyDeadzone(pad?.axes?.[axis] ?? 0, dz)

/** Deadzoned + expo-curved drive input: steering sticks, wheel axes. */
export const readDriveAxis = (pad, axis, dz = GP_DEADZONE_DRIVE, expo = 1.6) =>
  driveCurve(applyDeadzone(pad?.axes?.[axis] ?? 0, dz), expo)

/**
 * External wheel / pedal heuristic: wheels expose many axes/buttons and
 * usually report an id with "wheel" (G29/G920, T300, Fanatec). Never blocks
 * a standard pad — only widens the controls we listen to.
 */
export const isWheelLike = (pad) => {
  if (!pad) return false
  try {
    const id = String(pad.id || '').toLowerCase()
    if (/(wheel|driving force|g29|g920|g923|t300|t150|fanatec|thrustmaster|logitech)/.test(id)) return true
    const axes = pad.axes ? pad.axes.length : 0
    const btns = pad.buttons ? pad.buttons.length : 0
    if (axes >= 5 || btns >= 20) return true
  } catch {}
  return false
}

/**
 * Wheel pedal fallback: some wheels expose clutch/brake/gas on axes 1-3 and
 * the Gamepad button mapping swaps when the wheel is in a mode the browser
 * does not recognise. Returns 0..1 throttle from the strongest pedal-like
 * source (buttons RT/LT first, then axes 1/2 as brake/gas fallbacks).
 */
export const wheelPedals = (pad) => {
  let gas = padValue(pad, BTN.RT)
  let brake = padValue(pad, BTN.LT)
  try {
    const ax = pad?.axes ?? []
    // Axis 1 = brake-like, axis 2 = gas-like on several wheel firmwares
    // (rest at -1), remapped to 0..1.
    const axBrake = ax.length > 1 && Number.isFinite(ax[1]) ? (ax[1] + 1) / 2 : 0
    const axGas = ax.length > 2 && Number.isFinite(ax[2]) ? (ax[2] + 1) / 2 : 0
    if (axGas > gas) gas = Math.max(0, Math.min(1, axGas))
    if (axBrake > brake) brake = Math.max(0, Math.min(1, axBrake))
  } catch {}
  return { gas, brake }
}

/** Analog button value in [0, 1]. */
export const padValue = (pad, i) => {
  const b = pad?.buttons?.[i]
  if (!b) return 0
  if (typeof b.value === 'number') return b.value
  return b.pressed ? 1 : 0
}

export const padHeld = (pad, i) => padValue(pad, i) > 0.35

const prevHeld = new WeakMap()

/**
 * Rising-edge detector: true exactly once when the button goes from
 * released to held. Call once per frame per button.
 */
export const padEdge = (pad, i) => {
  if (!pad) return false
  const held = padHeld(pad, i)
  let prev = prevHeld.get(pad)
  if (!prev) {
    prev = {}
    prevHeld.set(pad, prev)
  }
  const was = !!prev[i]
  prev[i] = held
  return held && !was
}

/** Trigger vibration / haptic rumble if supported by browser & controller */
export const vibrateGamepad = (pad, durationMs = 150, weakMag = 0.5, strongMag = 0.5) => {
  if (!pad) return
  try {
    if (pad.vibrationActuator && typeof pad.vibrationActuator.playEffect === 'function') {
      pad.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: durationMs,
        weakMagnitude: weakMag,
        strongMagnitude: strongMag,
      })
    } else if (pad.hapticActuators && pad.hapticActuators[0] && typeof pad.hapticActuators[0].pulse === 'function') {
      pad.hapticActuators[0].pulse(strongMag, durationMs)
    }
  } catch (e) {
    /* ignore haptics unsupported */
  }
}
