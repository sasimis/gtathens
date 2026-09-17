import React from 'react'
import { motion } from 'framer-motion'
import { Camera, ChevronLeft, Keyboard, Monitor, RotateCcw, SlidersHorizontal } from 'lucide-react'
import useGameStore, { CAM_VIEWS, DEFAULT_SETTINGS } from '../store/useGameStore'

const Slider = ({ label, hint, value, min, max, step, format, onChange }) => (
  <div className="setting-row">
    <div className="setting-label">
      {label}
      {hint && <span className="setting-hint">{hint}</span>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="setting-value">{format ? format(value) : value}</div>
    </div>
  </div>
)

const Toggle = ({ label, hint, value, onChange }) => (
  <div className="setting-row">
    <div className="setting-label">
      {label}
      {hint && <span className="setting-hint">{hint}</span>}
    </div>
    <div
      className={`toggle ${value ? 'on' : ''}`}
      role="switch"
      aria-checked={value}
      tabIndex={0}
      onClick={() => onChange(!value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onChange(!value)
      }}
    />
  </div>
)

const SettingsMenu = () => {
  const settings = useGameStore((s) => s.settings)
  const updateSettings = useGameStore((s) => s.updateSettings)
  const resetSettings = useGameStore((s) => s.resetSettings)
  const closeSettings = useGameStore((s) => s.closeSettings)
  const camView = useGameStore((s) => s.camView ?? 1)
  const setCamView = useGameStore((s) => s.setCamView)

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
        initial={{ y: 24, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 12, opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        <h2 className="panel-title">
          <SlidersHorizontal size={24} />
          Settings
        </h2>

        <div className="panel-section">
          <div className="section-header">
            <Camera size={15} /> Camera
          </div>
          <div className="setting-row">
            <div className="setting-label">
              Camera view
              <span className="setting-hint">Fixed chase cam — keys 1/2/3 jump, V cycles. No zoom.</span>
            </div>
            <select
              value={camView}
              onChange={(e) => setCamView(Number(e.target.value))}
            >
              {CAM_VIEWS.map((v, i) => (
                <option key={v.id} value={i}>{v.label} ({v.distance.toFixed(1)} m)</option>
              ))}
            </select>
          </div>
          <Slider
            label="Field of view"
            hint="Wider FOV sees more of the city"
            value={settings.fov}
            min={50}
            max={100}
            step={1}
            format={(v) => `${v}°`}
            onChange={(v) => updateSettings({ fov: v })}
          />
          <Slider
            label="Camera smoothing"
            hint="Lower is snappier, higher is floatier"
            value={settings.smoothing}
            min={0}
            max={0.6}
            step={0.02}
            format={(v) => v.toFixed(2)}
            onChange={(v) => updateSettings({ smoothing: v })}
          />
        </div>

        <div className="panel-section">
          <h3>Audio</h3>
          <Slider
            label="Master volume"
            hint="Engine, gunfire, footsteps and ambience"
            value={settings.sfxVolume ?? 1}
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => updateSettings({ sfxVolume: v })}
          />
        </div>

        <div className="panel-section">
          <div className="section-header">
            <Monitor size={15} /> Graphics
          </div>
          <div className="setting-row">
            <div className="setting-label">
              Quality
              <span className="setting-hint">Render resolution and draw distance</span>
            </div>
            <select
              value={settings.quality}
              onChange={(e) => updateSettings({ quality: e.target.value })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <Toggle
            label="Shadows"
            hint="Sun shadows on buildings and streets"
            value={settings.shadows}
            onChange={(v) => updateSettings({ shadows: v })}
          />
        </div>

        <div className="panel-section">
          <div className="section-header">
            <Keyboard size={15} /> On Foot Controls
          </div>
          <ul className="controls-list">
            <li><b>Move (W = forward)</b> <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or <kbd>Arrow Keys</kbd> — A/D strafe + turn slightly</li>
            <li><b>Run</b> <kbd>Shift</kbd></li>
            <li><b>Jump</b> <kbd>Space</kbd></li>
            <li><b>Fire</b> <kbd>X</kbd> or <kbd>LMB</kbd></li>
            <li><b>Reload</b> <kbd>R</kbd></li>
            <li><b>Cycle Weapon</b> <kbd>Q</kbd> / <kbd>E</kbd></li>
            <li><b>Inventory</b> <kbd>Tab</kbd> / <kbd>I</kbd></li>
            <li><b>Switch Character</b> <kbd>P</kbd></li>
            <li><b>Enter / Exit Vehicle</b> <kbd>F</kbd></li>
            <li><b>Camera views</b> <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> or <kbd>V</kbd> to cycle</li>
            <li><b>Controller</b> left stick move · right stick look · <kbd>A</kbd> jump · <kbd>X</kbd>/<kbd>LT</kbd> enter car · <kbd>RT</kbd> fire · <kbd>LB</kbd> reload · <kbd>RB</kbd> run · <kbd>Y</kbd> switch char</li>
            <li><b>Pause</b> <kbd>Esc</kbd></li>
          </ul>
        </div>

        <div className="panel-section">
          <div className="section-header">
            <Keyboard size={15} /> Driving Controls
          </div>
          <ul className="controls-list">
            <li><b>Accelerate</b> <kbd>W</kbd></li>
            <li><b>Reverse / Brake</b> <kbd>S</kbd></li>
            <li><b>Steer Left</b> <kbd>A</kbd></li>
            <li><b>Steer Right</b> <kbd>D</kbd></li>
            <li><b>Handbrake</b> <kbd>Space</kbd></li>
            <li><b>Exit Vehicle</b> <kbd>F</kbd></li>
            <li><b>Controller</b> <kbd>RT</kbd> gas · <kbd>LT</kbd> brake · left stick steer · <kbd>A</kbd> handbrake · <kbd>B</kbd> exit</li>
          </ul>
        </div>

        <div className="panel-actions">
          <button className="btn btn-small" onClick={resetSettings}>
            <RotateCcw size={16} />
            Defaults
          </button>
          <button className="btn btn-small btn-primary" onClick={closeSettings}>
            <ChevronLeft size={16} />
            Back
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

export default SettingsMenu

