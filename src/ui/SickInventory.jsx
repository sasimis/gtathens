// SickInventory — the two "actually sick" surfaces the HUD chips don't cover:
//   hold TAB  -> radial WEAPON WHEEL (framer-motion, like GTA V)
//   press I   -> draggable weapon GRID (dnd-kit DnD + framer-motion springs)
// Drag order in the grid IS the Q/E cycle order (store.cycleWeapon reads the
// weapons array, not WEAPON_ORDER) — reordering has real gameplay effect.
// The old SA panel's keyboard handling is superseded; clicking a slot equips.
import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable } from '@dnd-kit/core'
import useGameStore, { Phase } from '../store/useGameStore'
import { WEAPONS } from '../lib/weapons'
import { audio } from '../lib/audio'

const GLYPH = { fists: '✊', pistol: '🔫', smg: '💥' }
const glyphFor = (id) => GLYPH[id] || '▦'
const WHEEL_R = 130

// One wheel segment: fans out from the center on open, highlights on hover,
// equips on Tab release (or click). Positioned by angle — no CSS keyframes.
const WheelSlot = ({ id, i, n, active, ammo, onHover }) => {
  const ang = (i / n) * Math.PI * 2 - Math.PI / 2
  const x = Math.cos(ang) * WHEEL_R
  const y = Math.sin(ang) * WHEEL_R
  const def = WEAPONS[id]
  return (
    <motion.button
      className={`wheel-slot${active ? ' on' : ''}`}
      style={{ left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)` }}
      initial={{ opacity: 0, scale: 0.4 }}
      animate={{ opacity: 1, scale: active ? 1.18 : 1 }}
      exit={{ opacity: 0, scale: 0.4, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 500, damping: 26, delay: i * 0.02 }}
      onMouseEnter={() => onHover(id)}
      onClick={() => onHover(id)}
    >
      <span className="wheel-glyph">{glyphFor(id)}</span>
      <span className="wheel-name">{def ? def.name : id}</span>
      {ammo && <span className="wheel-ammo">{ammo.mag}/{ammo.reserve}</span>}
    </motion.button>
  )
}

// A grid cell that is BOTH a drag source and a drop target (the store splices
// `from` out and re-inserts before `to` — no swap).
const GridSlot = ({ id, ammo, equipped, onEquip }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id })
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id })
  const def = WEAPONS[id]
  return (
    <motion.div
      ref={(n) => { setNodeRef(n); setDropRef(n) }}
      {...listeners}
      {...attributes}
      className={`inv-cell${equipped ? ' on' : ''}${isOver ? ' drop' : ''}`}
      style={{ opacity: isDragging ? 0.35 : 1 }}
      whileHover={{ scale: 1.08 }}
      onClick={() => onEquip(id)}
    >
      <span className="inv-glyph">{glyphFor(id)}</span>
      <span className="inv-name">{def ? def.name : id}</span>
      <span className="inv-ammo">{ammo ? `${ammo.mag} / ${ammo.reserve}` : '—'}</span>
    </motion.div>
  )
}


const SickInventory = () => {
  const phase = useGameStore((s) => s.phase)
  const money = useGameStore((s) => s.money ?? 0)
  const health = useGameStore((s) => s.health ?? 100)
  const weapons = useGameStore((s) => s.weapons)
  const equipped = useGameStore((s) => s.equipped)
  const gridOpen = useGameStore((s) => s.inventoryOpen)
  const equip = useGameStore((s) => s.equipWeapon)
  const reorder = useGameStore((s) => s.reorderWeapon)
  const toggle = useGameStore((s) => s.toggleInventory)
  const close = useGameStore((s) => s.closeInventory)
  const [wheel, setWheel] = useState(false)
  const [hover, setHover] = useState(null)
  const tabDown = useRef(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Owns TAB (hold = wheel) and I (toggle grid). Inventory.jsx no longer
  // listens for either, so the two surfaces never fight.
  useEffect(() => {
    const down = (e) => {
      if (e.repeat) return
      const st = useGameStore.getState()
      if (st.phase !== Phase.PLAYING) return
      if (e.code === 'Tab') {
        e.preventDefault()
        tabDown.current = true
        setHover(st.equipped)
        setWheel(true)
        audio.play('wheel')
      } else if (e.code === 'KeyI') {
        st.toggleInventory()
        audio.play('wheel')
      }
    }
    const up = (e) => {
      if (e.code !== 'Tab' || !tabDown.current) return
      tabDown.current = false
      setWheel(false)
      if (hover) useGameStore.getState().equipWeapon(hover)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [hover])

  // Q/E or arrows sweep the wheel while it is held (no pointer needed).
  useEffect(() => {
    if (!wheel) return
    const order = ['fists', ...weapons.map((w) => w.id)]
    const onKey = (e) => {
      if (e.code !== 'ArrowRight' && e.code !== 'ArrowLeft') return
      e.preventDefault()
      const i = order.indexOf(hover ?? equipped)
      const d = e.code === 'ArrowRight' ? 1 : -1
      setHover(order[(i + d + order.length) % order.length])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wheel, weapons, hover, equipped])

  useEffect(() => {
    if (phase !== Phase.PLAYING && (gridOpen || wheel)) {
      close()
      setWheel(false)
    }
  }, [phase, gridOpen, wheel, close])

  if (phase !== Phase.PLAYING) return null
  const slots = ['fists', ...weapons.map((w) => w.id)]
  const ammoOf = (id) => (id === 'fists' ? null : weapons.find((w) => w.id === id) || null)

  return (
    <AnimatePresence>
      {wheel && (
        <motion.div
          className="wheel-screen"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onMouseUp={() => { tabDown.current = false; setWheel(false); if (hover) equip(hover) }}
        >
          <div className="wheel-ring" />
          <div className={`wheel-core${hover && hover !== equipped ? ' new' : ''}`}>
            {hover ? (WEAPONS[hover]?.name || hover) : '—'}
          </div>
          {slots.map((id, i) => (
            <WheelSlot key={id} id={id} i={i} n={slots.length}
              active={hover === id || (slots.length === 1 && id === equipped)}
              ammo={ammoOf(id)}
              onHover={setHover}
            />
          ))}
          <div className="wheel-hint">hold Tab · release to equip</div>
        </motion.div>
      )}
      {gridOpen && (
        <motion.div
          className="panel-screen sick-screen"
          onClick={close}
          initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 60, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        >
          <motion.div className="sick-panel" onClick={(e) => e.stopPropagation()}
            initial={{ scale: 0.94 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
            <div className="sick-title">INVENTORY</div>
            <div className="sick-cash">${money}</div>
            <DndContext sensors={sensors} onDragEnd={({ active, over }) => {
              if (over && active.id !== over.id) {
                reorder(active.id, over.id)
                audio.play('pickup', 1.4, 0.5)
              }
            }}>
              <div className="sick-grid">
                {slots.map((id) => (
                  <GridSlot key={id} id={id} ammo={ammoOf(id)} equipped={equipped === id} onEquip={equip} />
                ))}
              </div>
            </DndContext>
            <div className="sick-stats">
              <span className="hp-track sick-hp-track">
                <span className="hp-fill" style={{ width: `${health}%` }} />
              </span>
              <span className="sick-hint">drag to reorder · Q/E follows this order · I close</span>
            </div>
            <div className="panel-actions">
              <button className="btn btn-small" onClick={close}>Close (I)</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default SickInventory
