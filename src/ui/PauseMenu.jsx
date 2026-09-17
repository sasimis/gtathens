import React from 'react'
import { motion } from 'framer-motion'
import { Home, Play, Settings } from 'lucide-react'
import useGameStore, { Phase } from '../store/useGameStore'

const PauseMenu = () => {
  const resumeGame = useGameStore((s) => s.resumeGame)
  const openSettings = useGameStore((s) => s.openSettings)
  const toMainMenu = useGameStore((s) => s.toMainMenu)

  return (
    <motion.div
      className="panel-screen"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="panel"
        style={{ width: 'min(420px, 94vw)' }}
        initial={{ y: 24, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 12, opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <div className="pause-title">
          <h2>Paused</h2>
        </div>
        <div className="menu-buttons" style={{ width: '100%' }}>
          <button className="btn btn-primary" onClick={resumeGame}>
            <Play size={20} />
            Resume
          </button>
          <button className="btn" onClick={() => openSettings(Phase.PAUSED)}>
            <Settings size={20} />
            Settings
          </button>
          <button className="btn" onClick={toMainMenu}>
            <Home size={20} />
            Main Menu
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

export default PauseMenu
