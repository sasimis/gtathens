// Shared gamepad helpers (W3C Standard mapping).
// Used by Player (on foot) and CarDriver (driving) so controller support
// stays consistent. All helpers tolerate a missing/disconnected pad.

export const GP_DEADZONE = 0.18

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
}

export const applyDeadzone = (v, dz = GP_DEADZONE) => {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0
  if (Math.abs(v) < dz) return 0
  return (v - Math.sign(v) * dz) / (1 - dz)
}

/** First connected gamepad, or null. */
export const getGamepad = () => {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null
  try {
    const pads = navigator.getGamepads()
    for (const p of pads) {
      if (p && p.connected) return p
    }
  } catch (e) {
    return null
  }
  return null
}

/** Deadzoned stick axis value in [-1, 1]. */
export const readStick = (pad, axis) => applyDeadzone(pad?.axes?.[axis] ?? 0)

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
