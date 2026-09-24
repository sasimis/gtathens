import React, { useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useProgress } from '@react-three/drei'
import useGameStore, { Phase } from '../store/useGameStore'
import MainMenu from './MainMenu'
import SettingsMenu from './SettingsMenu'
import PauseMenu from './PauseMenu'
import Hud from './Hud'
import StreetHUD from './StreetHUD'
import Minimap from './Minimap'
import Crosshair from './Crosshair'
import RadioMenu from './RadioMenu'
import { BTN, getGamepad, padEdge } from '../lib/gamepad'

const MenuRoot = () => {
  const phase = useGameStore((s) => s.phase)
  const pauseGame = useGameStore((s) => s.pauseGame)
  const resumeGame = useGameStore((s) => s.resumeGame)
  const closeSettings = useGameStore((s) => s.closeSettings)
  const toggleRadioMenu = useGameStore((s) => s.toggleRadioMenu)
  const driving = useGameStore((s) => s.driving)
  const drivingAi = useGameStore((s) => s.drivingAi)
  const { progress } = useProgress()
  const loaded = progress >= 100

  const isDriving = driving !== null || drivingAi !== null

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Escape') {
        if (phase === Phase.PLAYING) pauseGame()
        else if (phase === Phase.PAUSED) resumeGame()
        else if (phase === Phase.SETTINGS) closeSettings()
      } else if (e.code === 'KeyM' && !e.repeat) {
        if (phase === Phase.PLAYING && isDriving) {
          toggleRadioMenu()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, pauseGame, resumeGame, closeSettings, toggleRadioMenu, isDriving])

  useEffect(() => {
    let animId = null
    const checkGamepadMenu = () => {
      const pad = getGamepad()
      if (pad) {
        if (padEdge(pad, BTN.START)) {
          if (phase === Phase.PLAYING) pauseGame()
          else if (phase === Phase.PAUSED) resumeGame()
          else if (phase === Phase.SETTINGS) closeSettings()
        } else if (padEdge(pad, BTN.B)) {
          if (phase === Phase.PAUSED) resumeGame()
          else if (phase === Phase.SETTINGS) closeSettings()
        }
      }
      animId = requestAnimationFrame(checkGamepadMenu)
    }
    animId = requestAnimationFrame(checkGamepadMenu)
    return () => cancelAnimationFrame(animId)
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
      {phase === Phase.PLAYING && <Crosshair />}
      {phase === Phase.PLAYING && <Minimap />}
      {phase === Phase.PLAYING && <RadioMenu />}
    </div>
  )
}

export default MenuRoot
