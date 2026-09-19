// Shared mouse-aim state (numbers only, no per-frame alloc).
// Crosshair.jsx writes it on mousemove (cheap DOM transform, no React state);
// WeaponController.jsx reads it to build the camera ray, so bullets land
// where the cursor points. NDC default (0,0) = screen center, which keeps the
// headless smoke test (X-key burst, no mouse) aiming straight ahead.
export const mouseAim = {
  // Normalized device coords for THREE unprojection.
  nx: 0,
  ny: 0,
  // CSS pixels (for the crosshair div transform).
  px: typeof window !== 'undefined' ? window.innerWidth / 2 : 0,
  py: typeof window !== 'undefined' ? window.innerHeight / 2 : 0,
  has: false,
}

export const updateMouseAim = (clientX, clientY) => {
  const w = window.innerWidth || 1
  const h = window.innerHeight || 1
  mouseAim.nx = (clientX / w) * 2 - 1
  mouseAim.ny = -(clientY / h) * 2 + 1
  mouseAim.px = clientX
  mouseAim.py = clientY
  mouseAim.has = true
  // Cheap seam for headless probes / debugging (stable object, no alloc).
  if (typeof window !== 'undefined') window.__gtathensAim = mouseAim
}

if (typeof window !== 'undefined') window.__gtathensAim = mouseAim
