import React, { useEffect } from 'react'
import useGameStore from '../store/useGameStore'

const KeyIcon = ({ children, wide }) => (
  <span className={`key-icon ${wide ? 'key-wide' : ''}`}>
    {children}
  </span>
)

const ButtonA = () => (
  <span className="gamepad-btn gamepad-a">
    <svg viewBox="0 0 24 24" width="16" height="16">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold">A</text>
    </svg>
  </span>
)

const ButtonB = () => (
  <span className="gamepad-btn gamepad-b">
    <svg viewBox="0 0 24 24" width="16" height="16">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold">B</text>
    </svg>
  </span>
)

const ButtonX = () => (
  <span className="gamepad-btn gamepad-x">
    <svg viewBox="0 0 24 24" width="16" height="16">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold">X</text>
    </svg>
  </span>
)

const ButtonY = () => (
  <span className="gamepad-btn gamepad-y">
    <svg viewBox="0 0 24 24" width="16" height="16">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="12" y="16" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold">Y</text>
    </svg>
  </span>
)

const StickIcon = ({ side }) => (
  <span className={`stick-icon ${side}`}>
    <svg viewBox="0 0 24 24" width="18" height="18">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.6" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
    </svg>
  </span>
)

const TriggerIcon = ({ label, side }) => (
  <span className={`trigger-icon trigger-${side}`}>
    <svg viewBox="0 0 24 24" width="20" height="16">
      <path d={side === 'left' ? "M12 6h6v12h-6zM6 10h6v8H6z" : "M6 6h6v12H6zM12 10h6v8h-6z"} fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="9" y="15" textAnchor="middle" fill="currentColor" fontSize="7" fontWeight="bold">{label}</text>
    </svg>
  </span>
)

const PromptRow = ({ icon, action }) => (
  <div className="prompt-row">
    <span className="prompt-icon">{icon}</span>
    <span className="prompt-action">{action}</span>
  </div>
)

const KeyboardOnFoot = () => (
  <div className="prompt-set keyboard-prompts">
    <PromptRow icon={<KeyIcon>W</KeyIcon>} action="Forward" />
    <PromptRow icon={<KeyIcon>S</KeyIcon>} action="Backward" />
    <PromptRow icon={<KeyIcon>A</KeyIcon>} action="Left" />
    <PromptRow icon={<KeyIcon>D</KeyIcon>} action="Right" />
    <PromptRow icon={<KeyIcon wide>Shift</KeyIcon>} action="Sprint" />
    <PromptRow icon={<KeyIcon wide>Space</KeyIcon>} action="Jump" />
    {/* Weapons (WeaponController): X fire, R reload, Q/E cycle, I inventory */}
    <PromptRow icon={<KeyIcon>X</KeyIcon>} action="Fire Weapon" />
    <PromptRow icon={<KeyIcon>R</KeyIcon>} action="Reload" />
    <PromptRow icon={<KeyIcon>Q</KeyIcon>} action="Prev Weapon" />
    <PromptRow icon={<KeyIcon>E</KeyIcon>} action="Next Weapon" />
    <PromptRow icon={<KeyIcon wide>Tab</KeyIcon>} action="Inventory" />
    <PromptRow icon={<KeyIcon>P</KeyIcon>} action="Switch Character" />
    <PromptRow icon={<KeyIcon>F</KeyIcon>} action="Enter / Exit Vehicle" />
    <PromptRow icon={<KeyIcon>Esc</KeyIcon>} action="Pause Menu" />
  </div>
)

const GamepadOnFoot = () => (
  <div className="prompt-set gamepad-prompts">
    <PromptRow icon={<StickIcon side="left" />} action="Move" />
    <PromptRow icon={<StickIcon side="right" />} action="Look / Aim" />
    <PromptRow icon={<ButtonA />} action="Jump" />
    <PromptRow icon={<ButtonY />} action="Enter Vehicle / Switch Char" />
    <PromptRow icon={<ButtonB />} action="Exit Vehicle" />
    <PromptRow icon={<ButtonX />} action="Enter Vehicle (alt)" />
    <PromptRow icon={<StickIcon side="right" />} action="Camera / Aim" />
    <PromptRow icon={<TriggerIcon label="RT" side="right" />} action="Fire Weapon" />
    <PromptRow icon={<TriggerIcon label="LB" side="left" />} action="Reload" />
    <PromptRow icon={<TriggerIcon label="RB" side="right" />} action="Sprint" />
    <PromptRow icon={<TriggerIcon label="LT" side="left" />} action="Enter Vehicle" />
    <PromptRow icon={<KeyIcon>Start</KeyIcon>} action="Pause Menu" />
  </div>
)

const KeyboardDriving = () => (
  <div className="prompt-set keyboard-prompts">
    <PromptRow icon={<KeyIcon>W</KeyIcon>} action="Accelerate" />
    <PromptRow icon={<KeyIcon>S</KeyIcon>} action="Reverse / Brake" />
    <PromptRow icon={<KeyIcon>A</KeyIcon>} action="Steer Left" />
    <PromptRow icon={<KeyIcon>D</KeyIcon>} action="Steer Right" />
    <PromptRow icon={<KeyIcon wide>Shift</KeyIcon>} action="Nitro Boost" />
    <PromptRow icon={<KeyIcon wide>Space</KeyIcon>} action="Brake" />
    <PromptRow icon={<KeyIcon>H</KeyIcon>} action="Horn" />
    <PromptRow icon={<KeyIcon>M</KeyIcon>} action="Radio Stations" />
    <PromptRow icon={<KeyIcon>F</KeyIcon>} action="Exit Vehicle" />
    <PromptRow icon={<KeyIcon>Esc</KeyIcon>} action="Pause Menu" />
  </div>
)

const GamepadDriving = () => (
  <div className="prompt-set gamepad-prompts">
    <PromptRow icon={<TriggerIcon label="RT" side="right" />} action="Accelerate" />
    <PromptRow icon={<TriggerIcon label="LT" side="left" />} action="Reverse / Brake" />
    <PromptRow icon={<StickIcon side="left" />} action="Steer" />
    <PromptRow icon={<StickIcon side="right" />} action="Camera Orbit" />
    <PromptRow icon={<ButtonA />} action="Brake / Handbrake" />
    <PromptRow icon={<ButtonX />} action="Nitro Boost" />
    <PromptRow icon={<ButtonY />} action="Exit Vehicle (alt)" />
    <PromptRow icon={<ButtonB />} action="Exit Vehicle" />
    <PromptRow icon={<KeyIcon>Start</KeyIcon>} action="Pause Menu" />
    <PromptRow icon={<TriggerIcon label="RB" side="right" />} action="Horn" />
  </div>
)

const InputPrompts = () => {
  const driving = useGameStore((s) => s.driving)
  const phase = useGameStore((s) => s.phase)
  const [useGamepad, setUseGamepad] = React.useState(false)
  const [visible, setVisible] = React.useState(false)

  // The prompts panel is opt-in (F1): an always-on full-height fixed column
  // reads as a dark "sidebar" bar and steals pointer events from the canvas.
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'F1') {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  React.useEffect(() => {
    const onConnect = () => setUseGamepad(true)
    const onDisconnect = () => setUseGamepad(false)
    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : []
    if (Array.from(gamepads).some(g => g)) setUseGamepad(true)
    return () => {
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
    }
  }, [])

  if (phase !== 'PLAYING' && phase !== 'PAUSED') return null
  if (!visible) return null

  return (
    <div className="input-prompts">
      <div className="prompts-header">
        <span className="prompts-title">CONTROLS (F1)</span>
        <button
          className="prompts-toggle"
          onClick={() => setUseGamepad(g => !g)}
          title="Toggle input device"
        >
          {useGamepad ? '🎮' : '⌨️'}
        </button>
      </div>
      <div className="prompts-body">
        {driving !== null
          ? (useGamepad ? <GamepadDriving /> : <KeyboardDriving />)
          : (useGamepad ? <GamepadOnFoot /> : <KeyboardOnFoot />)
        }
      </div>
    </div>
  )
}

export default InputPrompts

