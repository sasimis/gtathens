// Player inventory overlay: pickup toasts, hit feedback, reload bar and the
// GTA:SA-style weapon picker panel. Persistent HUD chips (clock + cash) live
// in Hud.jsx — this overlay keeps only transient feedback + the picker.
import React, { useEffect, useState } from 'react'
import useGameStore, { Phase } from '../store/useGameStore'
import { WEAPONS, WEAPON_ORDER } from '../lib/weapons'

// GTA: San Andreas weapon wheel order (slots left -> right, top -> bottom).
// Fists first, then everything the player actually owns.
const SA_SLOTS = [...WEAPON_ORDER]

// Tiny monochrome glyph per weapon id so the grid reads at a glance without
// importing asset art (the game is asset-free low-poly).
const GLYPH = { fists: '✊', pistol: '🔫', smg: '🔫' }
const glyphFor = (id) => GLYPH[id] || '▦'

const Inventory = () => {
  const phase = useGameStore((s) => s.phase)
  const money = useGameStore((s) => s.money ?? 0)
  const health = useGameStore((s) => s.health ?? 100)
  const weapons = useGameStore((s) => s.weapons)
  const equipped = useGameStore((s) => s.equipped)
  const open = useGameStore((s) => s.inventoryOpen)
  const toasts = useGameStore((s) => s.toasts)
  const close = useGameStore((s) => s.closeInventory)
  const equip = useGameStore((s) => s.equipWeapon)
  // Keyboard cursor inside the SA grid (Q/E or arrows move, F/E equip).
  const [cursor, setCursor] = useState(0)
  // HUD chips (cash / HP / weapon line) now live in Hud.jsx — this overlay
  // keeps only toasts, the reload bar and the SA picker panel.
  const barColor = (hp) => (hp > 55 ? '#57d977' : hp > 25 ? '#f5b800' : '#ff5a4e')

  // NOTE: Tab / I are owned by SickInventory (wheel on hold-Tab, dnd-kit grid
  // on I). This component keeps only transient feedback + the picker.
  useEffect(() => {
    if (phase !== Phase.PLAYING && open) close()
  }, [phase, open, close])

  // Slots for the SA grid: fists always slot 0, then owned guns in SA order.
  const owned = new Set(['fists', ...weapons.map((w) => w.id)])
  const slots = SA_SLOTS.filter((id) => owned.has(id))
  const magOf = (id) => {
    if (id === 'fists') return null
    const w = weapons.find((x) => x.id === id)
    return w ? { mag: w.mag, reserve: w.reserve } : null
  }

  // Keep the cursor on the equipped weapon whenever the panel opens.
  useEffect(() => {
    if (open) {
      const i = Math.max(0, slots.indexOf(equipped))
      setCursor(i)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Cursor keys while the panel is up: Q/E or arrows move, F/Enter equips.
  useEffect(() => {
    if (!open) return
    const onNav = (e) => {
      if (e.code === 'ArrowRight' || e.code === 'KeyE') { e.preventDefault(); setCursor((c) => (c + 1) % Math.max(1, slots.length)) }
      else if (e.code === 'ArrowLeft' || e.code === 'KeyQ') { e.preventDefault(); setCursor((c) => (c - 1 + slots.length) % Math.max(1, slots.length)) }
      else if (e.code === 'KeyF' || e.code === 'Enter') { e.preventDefault(); const id = slots[cursor]; if (id) equip(id) }
    }
    window.addEventListener('keydown', onNav)
    return () => window.removeEventListener('keydown', onNav)
  }, [open, slots, cursor, equip])

  if (phase !== Phase.PLAYING) return null

  return (
    <>
      <div className="hud-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
        ))}
      </div>
      {/* Reload progress. Owned by the DOM overlay (WeaponController renders
          inside <Canvas> and cannot output a div there): WeaponController
          writes `hidden` + the inner fill width through setReloadUI(). */}
      <div className="reload-track" id="gtathens-reload" hidden>
        <div className="reload-bar" />
      </div>
      {open && (
        <div className="panel-screen sa-screen" onClick={close}>
          {/* GTA: San Andreas weapon picker: dark translucent bar grid with a
              green selection box. Q/E or arrows move, F/Enter equips. */}
          <div className="sa-panel" onClick={(e) => e.stopPropagation()}>
            <div className="sa-title">WEAPONS</div>
            <div className="sa-cash">${money}</div>
            <div className="sa-grid">
              {slots.map((id, i) => {
                const def = WEAPONS[id]
                const ammo = magOf(id)
                const isCur = i === cursor
                const isOn = equipped === id
                return (
                  <button
                    key={id}
                    className={`sa-slot${isCur ? ' cur' : ''}${isOn ? ' on' : ''}`}
                    onClick={() => equip(id)}
                    onMouseEnter={() => setCursor(i)}
                  >
                    <span className="sa-glyph">{glyphFor(id)}</span>
                    <span className="sa-name">{def ? def.name : id}</span>
                    <span className="sa-ammo">{ammo ? `${ammo.mag} / ${ammo.reserve}` : '—'}</span>
                  </button>
                )
              })}
            </div>
            <div className="sa-stats">
              <span className="sa-hp">
                <span className="hp-track sa-hp-track">
                  <span className="hp-fill" style={{ width: `${health}%`, background: barColor(health) }} />
                </span>
                {health}
              </span>
              <span className="sa-hint">Q/E move · F equip · Tab close</span>
            </div>
            <div className="panel-actions">
              <button className="btn btn-small" onClick={close}>Close (Tab)</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default Inventory
