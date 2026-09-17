import React, { useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useProgress } from '@react-three/drei'
import useGameStore, { Phase } from '../store/useGameStore'
import MainMenu from './MainMenu'
import SettingsMenu from './SettingsMenu'
import PauseMenu from './PauseMenu'
import Hud from './Hud'
import StreetHUD from './StreetHUD'

const MenuRoot = () => {
  const phase = useGameStore((s) => s.phase)
  const pauseGame = useGameStore((s) => s.pauseGame)
  const resumeGame = useGameStore((s) => s.resumeGame)
  const closeSettings = useGameStore((s) => s.closeSettings)
  const { progress } = useProgress()
  const loaded = progress >= 100

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Escape') return
      if (phase === Phase.PLAYING) pauseGame()
      else if (phase === Phase.PAUSED) resumeGame()
      else if (phase === Phase.SETTINGS) closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, pauseGame, resumeGame, closeSettings])

  return (
    <div className="ui-root">
      <AnimatePresence mode="wait">
        {phase === Phase.MAIN_MENU && <MainMenu key="menu" loaded={loaded} />}
        {phase === Phase.SETTINGS && <SettingsMenu key="settings" />}
        {phase === Phase.PAUSED && <PauseMenu key="pause" />}
      </AnimatePresence>
      {phase === Phase.PLAYING && <Hud />}
      {phase === Phase.PLAYING && <StreetHUD />}
    </div>
  )
}

export default MenuRoot
