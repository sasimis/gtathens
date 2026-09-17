import React from 'react'
import { motion } from 'framer-motion'
import { Play, Settings, ChevronLeft, ChevronRight } from 'lucide-react'
import { useProgress } from '@react-three/drei'
import useGameStore, { Phase } from '../store/useGameStore'
import { CHARACTERS } from '../components/Protagonist'

const MainMenu = ({ loaded }) => {
  const startGame = useGameStore((s) => s.startGame)
  const openSettings = useGameStore((s) => s.openSettings)
  const character = useGameStore((s) => s.character)
  const setCharacter = useGameStore((s) => s.setCharacter)
  const { progress } = useProgress()

  const idx = Math.abs(character) % CHARACTERS.length
  const char = CHARACTERS[idx] ?? CHARACTERS[0]

  return (
    <motion.div
      className="menu-screen"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <motion.div
        className="menu-title"
        initial={{ y: -30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.15, duration: 0.5, ease: 'easeOut' }}
      >
        <h1>
          GTA<span>THENS</span>
        </h1>
        <p className="tagline">Low-poly open world built from real OSM data</p>
      </motion.div>

      <motion.div
        className="menu-char-select"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.25, duration: 0.4 }}
      >
        <button
          className="char-nav"
          onClick={() => setCharacter((idx - 1 + CHARACTERS.length) % CHARACTERS.length)}
          aria-label="Previous character"
        >
          <ChevronRight size={18} />
        </button>
        <div className="char-name">{char.name}</div>
        <button
          className="char-nav"
          onClick={() => setCharacter((idx + 1) % CHARACTERS.length)}
          aria-label="Next character"
        >
          <ChevronLeft size={18} />
        </button>
      </motion.div>

      <motion.div
        className="menu-buttons"
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.5, ease: 'easeOut' }}
      >
        <button className="btn btn-primary" disabled={!loaded} onClick={startGame}>
          <Play size={20} />
          {loaded ? 'Play' : 'Loading city…'}
        </button>
        <button className="btn" onClick={() => openSettings(Phase.MAIN_MENU)}>
          <Settings size={20} />
          Settings
        </button>
      </motion.div>

      {!loaded && (
        <div className="loading-wrap">
          <div className="loading-track">
            <div className="loading-fill" style={{ width: `${Math.round(progress)}%` }} />
          </div>
          <div className="loading-label">Building Athens — {Math.round(progress)}%</div>
        </div>
      )}

      <div className="menu-footer">
        Map data © OpenStreetMap contributors · 3D models by Kenney (CC0) · Built with React
        Three Fiber
      </div>
    </motion.div>
  )
}

export default MainMenu
