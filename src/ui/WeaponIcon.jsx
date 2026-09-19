// Crisp silhouette icons for every weapon, drawn as inline SVG so they stay
// sharp at any size and need no image assets. Each silhouette matches the
// procedural 3D model in lib/weapons.js (side view, muzzle pointing right).
// Shared by the Tab wheel, the I grid and the SA panel — one source of truth
// so no weapon ever falls back to a ▦ box again.
import React from 'react'

const PATHS = {
  // Fist viewed from the side.
  fists: 'M6 12 V7.5 Q6 5 8.5 5 H9 Q10 3.6 11.6 3.6 Q13 3.6 13.2 5 H14.5 Q16 5 16 6.6 H17 Q18.4 6.6 18.4 8 V9 Q20 9.4 20 11 V15 Q20 20 15.5 20 H11 Q6.5 20 6 15.5 Z M9 8 V12 M12 7 V12 M15 7.5 V12',
  // Pistol: slide + frame + grip + rear sight.
  pistol: 'M2 9 H16 V7 H19 V9 H22 V11 H16 V12 H9 L7.5 19 H3.5 L5 12 H2 Z M5 7.5 H12 V9 H5 Z',
  // Revolver: heavy frame, cylinder bulge, short barrel, long grip.
  revolver: 'M14 9 H21 V11 H14 Z M4 8 H14 V12 H5 L3.5 19 H0.5 L2 12 H4 Z M8 8 A3 3 0 1 0 8 14 A3 3 0 1 0 8 8 Z',
  // SMG: compact body, top rail, short mag, stock.
  smg: 'M1 8 H5 V6 H13 V8 H20 L22 9.5 V11 H14 L13 15 H10 L11 11 H7 L6 16 H3 Z M7 6 H11 V7.5 H7 Z',
  // Rifle: long receiver, rail, box mag, foregrip, stock.
  rifle: 'M1 9 H4 V7 H16 V9 H23 V11 H16 L15 16 H12 L13 11 H9 L8 16 H5 Z M6 6 H12 V7.5 H6 Z',
  // Shotgun: long barrel + rib, tube mag, pump, stock.
  shotgun: 'M3 8 H21 V9.5 H21 V11 H9 L7.5 17 H4 L5.5 11 H3 Z M5 6.5 H17 V8 H5 Z M9 12 H13 V14 H9 Z',
  // Marksman: extra-long barrel, scope, bolt handle, stock.
  marksman: 'M0 9 H22 V10.5 H0 Z M6 6 H12 V8 H6 Z M13 5.5 H14.5 V8 H13 Z M15 11 H16.5 V15 H15 Z M4 11 L3 16 H6 L7 11 Z',
}

const WeaponIcon = ({ id, size = 30 }) => {
  if (id === 'fists') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={PATHS.fists} fill="currentColor" stroke="none" opacity={0.9} />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[id] || PATHS.pistol} fill="currentColor" opacity={0.92} />
    </svg>
  )
}

export default WeaponIcon
