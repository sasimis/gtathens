import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Camera,
  ChevronLeft,
  Gamepad2,
  Keyboard,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  SlidersHorizontal,
  Volume2,
} from 'lucide-react'
import useGameStore, { CAM_VIEWS } from '../store/useGameStore'

const Slider = ({ label, hint, value, min, max, step, format, onChange }) => (
  <div className="setting-row">
    <div className="setting-label">
      {label}
      {hint && <span className="setting-hint">{hint}</span>}
    </div>
    <div className="setting-control-group">
      <input
        type="range"
        className="custom-range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="setting-value-badge">{format ? format(value) : value}</div>
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
      className={`toggle-switch ${value ? 'on' : ''}`}
      role="switch"
      aria-checked={value}
      tabIndex={0}
      onClick={() => onChange(!value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onChange(!value)
      }}
    >
      <div className="toggle-thumb" />
    </div>
  </div>
)

const SettingsMenu = () => {
  const settings = useGameStore((s) => s.settings)
  const updateSettings = useGameStore((s) => s.updateSettings)
  const resetSettings = useGameStore((s) => s.resetSettings)
  const closeSettings = useGameStore((s) => s.closeSettings)
  const camView = useGameStore((s) => s.camView ?? 1)
  const setCamView = useGameStore((s) => s.setCamView)

  const [activeTab, setActiveTab] = useState('camera')
  const [collapsed, setCollapsed] = useState(false)

  const navItems = [
    { id: 'camera', label: 'Camera', icon: Camera },
    { id: 'audio', label: 'Audio', icon: Volume2 },
    { id: 'graphics', label: 'Graphics', icon: Monitor },
    { id: 'controls', label: 'Controls', icon: Keyboard },
  ]

  return (
    <motion.div
      className="panel-screen settings-screen"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="settings-modal"
        initial={{ y: 20, opacity: 0, scale: 0.98 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        exit={{ y: 12, opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        {/* Left Nav Rail */}
        <div className={`settings-sidebar ${collapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-header">
            <SlidersHorizontal size={20} className="header-icon" />
            {!collapsed && <span className="sidebar-title">SETTINGS</span>}
            <button
              className="collapse-btn"
              onClick={() => setCollapsed(!collapsed)}
              title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
          </div>

          <div className="sidebar-nav">
            {navItems.map((item) => {
              const Icon = item.icon
              const isActive = activeTab === item.id
              return (
                <button
                  key={item.id}
                  className={`nav-item ${isActive ? 'active' : ''}`}
                  onClick={() => setActiveTab(item.id)}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon size={18} />
                  {!collapsed && <span className="nav-label">{item.label}</span>}
                </button>
              )
            })}
          </div>

          <div className="sidebar-footer">
            <button className="btn-icon-text" onClick={resetSettings} title="Reset Settings">
              <RotateCcw size={16} />
              {!collapsed && <span>Defaults</span>}
            </button>
          </div>
        </div>

        {/* Right Content Area */}
        <div className="settings-content">
          <AnimatePresence mode="wait">
            {activeTab === 'camera' && (
              <motion.div
                key="camera"
                className="settings-section"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
              >
                <div className="section-title">
                  <Camera size={20} />
                  <span>Camera Options</span>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    Camera view preset
                    <span className="setting-hint">1/2/3 jump, V cycles</span>
                  </div>
                  <select
                    className="custom-select"
                    value={camView}
                    onChange={(e) => setCamView(Number(e.target.value))}
                  >
                    {CAM_VIEWS.map((v, i) => (
                      <option key={v.id} value={i}>{v.label} ({v.distance.toFixed(1)} m)</option>
                    ))}
                  </select>
                </div>

                <Slider
                  label="Field of View"
                  hint="Wider FOV sees more of the city"
                  value={settings.fov}
                  min={50}
                  max={100}
                  step={1}
                  format={(v) => `${v}°`}
                  onChange={(v) => updateSettings({ fov: v })}
                />

                <Slider
                  label="Camera Smoothing"
                  hint="Lower is snappier, higher is floatier"
                  value={settings.smoothing}
                  min={0}
                  max={0.6}
                  step={0.02}
                  format={(v) => v.toFixed(2)}
                  onChange={(v) => updateSettings({ smoothing: v })}
                />
              </motion.div>
            )}

            {activeTab === 'audio' && (
              <motion.div
                key="audio"
                className="settings-section"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
              >
                <div className="section-title">
                  <Volume2 size={20} />
                  <span>Audio & Sound</span>
                </div>

                <Slider
                  label="Master Volume"
                  hint="Engine, gunfire, footsteps and ambience"
                  value={settings.sfxVolume ?? 1}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => updateSettings({ sfxVolume: v })}
                />
              </motion.div>
            )}

            {activeTab === 'graphics' && (
              <motion.div
                key="graphics"
                className="settings-section"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
              >
                <div className="section-title">
                  <Monitor size={20} />
                  <span>Graphics & Rendering</span>
                </div>

                <div className="setting-row">
                  <div className="setting-label">
                    Render Quality
                    <span className="setting-hint">DPR resolution and draw distance</span>
                  </div>
                  <select
                    className="custom-select"
                    value={settings.quality}
                    onChange={(e) => updateSettings({ quality: e.target.value })}
                  >
                    <option value="low">Low (Performance)</option>
                    <option value="medium">Medium (Balanced)</option>
                    <option value="high">High (Ultra Detail)</option>
                  </select>
                </div>

                <Toggle
                  label="Sun Shadows"
                  hint="Real-time direction shadows on buildings & roads"
                  value={settings.shadows}
                  onChange={(v) => updateSettings({ shadows: v })}
                />
              </motion.div>
            )}

            {activeTab === 'controls' && (
              <motion.div
                key="controls"
                className="settings-section"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
              >
                <div className="section-title">
                  <Keyboard size={20} />
                  <span>Controls Reference</span>
                </div>

                <div className="controls-group">
                  <div className="group-header"><Keyboard size={14} /> On Foot</div>
                  <ul className="controls-grid">
                    <li><b>Move</b> <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></li>
                    <li><b>Sprint</b> <kbd>Shift</kbd></li>
                    <li><b>Jump</b> <kbd>Space</kbd></li>
                    <li><b>Fire</b> <kbd>X</kbd> / <kbd>LMB</kbd></li>
                    <li><b>Reload</b> <kbd>R</kbd></li>
                    <li><b>Inventory</b> <kbd>Tab</kbd> / <kbd>I</kbd></li>
                    <li><b>Cycle Gun</b> <kbd>Q</kbd> / <kbd>E</kbd></li>
                    <li><b>Enter Vehicle</b> <kbd>F</kbd></li>
                  </ul>
                </div>

                <div className="controls-group">
                  <div className="group-header"><Gamepad2 size={14} /> Driving</div>
                  <ul className="controls-grid">
                    <li><b>Gas / Brake</b> <kbd>W</kbd> / <kbd>S</kbd></li>
                    <li><b>Steer</b> <kbd>A</kbd> / <kbd>D</kbd></li>
                    <li><b>Handbrake</b> <kbd>Space</kbd></li>
                    <li><b>Exit Car</b> <kbd>F</kbd></li>
                    <li><b>Gamepad Gas</b> <kbd>RT</kbd></li>
                    <li><b>Gamepad Brake</b> <kbd>LT</kbd></li>
                  </ul>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="settings-footer">
            <button className="btn btn-primary btn-back" onClick={closeSettings}>
              <ChevronLeft size={16} />
              Close Settings
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}

export default SettingsMenu
