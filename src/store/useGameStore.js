import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { CHARACTERS } from '../components/Protagonist'
import { WEAPON_ORDER, WEAPONS } from '../lib/weapons'

export const Phase = {
  MAIN_MENU: 'MAIN_MENU',
  SETTINGS: 'SETTINGS',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
}

export const DEFAULT_SETTINGS = {
  // Camera (fixed presets — no free zoom; V / camera button cycles views)
  fov: 68,
  smoothing: 0.12,
  // Graphics
  shadows: true,
  quality: 'high', // 'low' | 'medium' | 'high'
  // Audio (master for BOTH buses: howler 2D + positional engines)
  sfxVolume: 1,
}

export const CAM_VIEWS = [
  { id: 'near', label: 'Near', distance: 5.5, height: 2.6, pitch: 0.22 },
  { id: 'standard', label: 'Standard', distance: 8.5, height: 3.6, pitch: 0.3 },
  { id: 'far', label: 'Far', distance: 12.5, height: 5.0, pitch: 0.36 },
]

const useGameStore = create(
  persist(
    (set, get) => ({
      phase: Phase.MAIN_MENU,
      // Where the Settings screen returns to when closed (menu or pause)
      settingsReturn: Phase.MAIN_MENU,
      settings: { ...DEFAULT_SETTINGS },
      // World-space [x, z] player spawn, computed from the road network
      spawn: null,
      // Selected playable character (index into Protagonist.CHARACTERS)
      character: 0,
      // Index (into the shared parking layout) of the car being driven, or
      // null while on foot. Setting it also unmounts the on-foot <Player>.
      driving: null,
      // Index into the AI traffic list (Npcs.jsx) of a STOLEN traffic car
      // being driven, or null. Kept separate from `driving` (parked indices)
      // so the two systems never collide — either one unmounts <Player>.
      drivingAi: null,
      // Nearest AI traffic car in reach (index, -1 = none). Shares the same
      // F prompt as parked cars.
      nearAiCar: -1,
      // Fixed chase-cam preset index (V key / HUD button cycles it).
      // 0 = near, 1 = standard, 2 = far. No free zoom by design.
      camView: 1,
      // Nearest car within reach of the on-foot player (index, -1 = none).
      // Drives the "press F to enter" HUD hint.
      nearCar: -1,
      // One-shot world transform where the character respawns after climbing
      // out of a car: { x, z, yaw }. Consumed by <Player> on its next mount.
      respawn: null,
      // Crash damage 0..1 of the car currently being driven (HUD chip).
      // Transient — never persisted; CarDriver resyncs it change-gated.
      carDamage: 0,

      // --- Economy / inventory (session-only, never persisted) -------------
      money: 0,
      health: 100,
      damageFlashAt: 0,
      // Owned guns: [{ id, mag, reserve }]. Fists are implicit and always
      // available (WEAPON_ORDER[0]) — they are never stored here.
      weapons: [],
      equipped: 'fists',
      inventoryOpen: false,
      // Floating pickup toasts [{ id, text, kind }] + last hitmarker time.
      toasts: [],
      hitAt: 0,
      killCount: 0,
      // Remaining cooldown (seconds) while switching weapons. While > 0 the
      // weapon controller suppresses fire/cycle input to keep the swap crisp.
      weaponChangeLeft: 0,

      setPhase: (phase) => set({ phase }),
      openSettings: (from) => set({ phase: Phase.SETTINGS, settingsReturn: from }),
      closeSettings: () => set({ phase: get().settingsReturn }),
      startGame: () => set({ phase: Phase.PLAYING }),
      pauseGame: () => set({ phase: Phase.PAUSED }),
      resumeGame: () => set({ phase: Phase.PLAYING }),
      toMainMenu: () =>
        set({ phase: Phase.MAIN_MENU, settingsReturn: Phase.MAIN_MENU }),
      updateSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),
      resetSettings: () => set({ settings: { ...DEFAULT_SETTINGS } }),
      setSpawn: (spawn) => set({ spawn: spawn ?? [0, 0] }),
      setCharacter: (i) => set({ character: i }),
      cycleCharacter: () => set({ character: (get().character + 1) % CHARACTERS.length }),
      setDriving: (i) => set({ driving: i ?? null }),
      clearDriving: () => set({ driving: null }),
      setDrivingAi: (i) => set({ drivingAi: i ?? null }),
      clearDrivingAi: () => set({ drivingAi: null }),
      setNearCar: (i) => set({ nearCar: i ?? -1 }),
      setNearAiCar: (i) => set({ nearAiCar: i ?? -1 }),
      setRespawn: (p) => set({ respawn: p }),
      clearRespawn: () => set({ respawn: null }),
      setCarDamage: (d) => set({ carDamage: Math.max(0, Math.min(1, Number(d) || 0)) }),
      // --- Economy / inventory actions -------------------------------------
      addMoney: (n) => set((s) => ({ money: Math.max(0, Math.round(s.money + (Number(n) || 0))) })),
      setHealth: (h) => set({ health: Math.max(0, Math.min(100, Math.round(Number(h) || 0))) }),
      // Grants a gun (or tops up ammo if already owned). Auto-equips when the
      // player only had fists — picking up your first gun should feel instant.
      giveWeapon: (id, ammo = 0) => {
        const def = WEAPONS[id]
        if (!def || def.melee) return
        const owned = get().weapons
        const has = owned.find((w) => w.id === id)
        if (has) {
          set({ weapons: owned.map((w) => (w.id === id ? { ...w, reserve: w.reserve + ammo } : w)) })
          return
        }
        set({
          weapons: [...owned, { id, mag: def.mag, reserve: ammo }],
          equipped: get().equipped === 'fists' ? id : get().equipped,
        })
      },
      addAmmo: (id, n) =>
        set((s) => ({
          weapons: s.weapons.map((w) => (w.id === id ? { ...w, reserve: w.reserve + n } : w)),
        })),
      equipWeapon: (id) =>
        set((s) => ({
          equipped:
            id === 'fists' || s.weapons.some((w) => w.id === id) ? id : s.equipped,
          weaponChangeLeft: 0.12,
        })),
      cycleWeapon: (dir = 1) => {
        // Order = the store's own weapons ARRAY (fists first), NOT WEAPON_ORDER
        // — that is what makes drag-reorder in the inventory grid matter:
        // Q/E cycles in the order the player arranged.
        const order = ['fists', ...get().weapons.map((w) => w.id)]
        const i = Math.max(0, order.indexOf(get().equipped))
        const next =
          order[(i + (dir > 0 ? 1 : order.length - 1)) % order.length] ?? 'fists'
        // Short pause on weapon change so input doesn't race ahead of the
        // animation / muzzle swap. weaponChangeLeft is drained by WeaponController.
        set({ equipped: next, weaponChangeLeft: 0.15 })
      },
      // Drag & drop reorder (SickInventory grid): move gun `fromId` onto `toId`.
      // Fists are implicit and never move.
      reorderWeapon: (fromId, toId) =>
        set((s) => {
          const a = s.weapons
          const fi = a.findIndex((w) => w.id === fromId)
          const ti = a.findIndex((w) => w.id === toId)
          if (fi < 0 || ti < 0 || fi === ti) return {}
          const next = a.slice()
          const [moved] = next.splice(fi, 1)
          next.splice(ti, 0, moved)
          return { weapons: next }
        }),
      // One round out of the equipped gun's magazine (fire events only — rare).
      spendMag: () =>
        set((s) => ({
          weapons: s.weapons.map((w) =>
            w.id === s.equipped ? { ...w, mag: Math.max(0, w.mag - 1) } : w,
          ),
        })),
      reloadWeapon: () =>
        set((s) => {
          const w = s.weapons.find((x) => x.id === s.equipped)
          const def = w && WEAPONS[w.id]
          if (!w || !def) return {}
          const take = Math.min(def.mag - w.mag, w.reserve)
          if (take <= 0) return {}
          return {
            weapons: s.weapons.map((x) =>
              x.id === w.id ? { ...x, mag: x.mag + take, reserve: x.reserve - take } : x,
            ),
          }
        }),
      // Master audio volume (both buses) — called by SettingsMenu's slider.
      setSfxVolume: (v) => {
        const vol = Math.max(0, Math.min(1, Number(v) || 0))
        set({ settings: { ...get().settings, sfxVolume: vol } })
        import('../lib/audio').then(({ audio }) => audio.setMasterVolume(vol)).catch(() => {})
      },
      toggleInventory: () => set((s) => ({ inventoryOpen: !s.inventoryOpen })),
      closeInventory: () => set({ inventoryOpen: false }),
      pushToast: (text, kind = 'info') => {
        const id = ++toastSeq
        set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }))
        setTimeout(
          () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
          2600,
        )
      },
      setHitAt: (t) => set({ hitAt: t }),
      addKill: () => set((s) => ({ killCount: (s.killCount || 0) + 1 })),
      setGameTime: (t) => set({ gameTime: t }),
      // Decrements the weapon-change cooldown by dt; caller drives the rate.
      drainWeaponChange: (dt) =>
        set((s) => ({ weaponChangeLeft: Math.max(0, s.weaponChangeLeft - dt) })),
      setCamView: (i) =>
        set({ camView: Math.min(2, Math.max(0, Number.isFinite(i) ? i : 1)) }),
      cycleCamView: () => set({ camView: (get().camView + 1) % 3 }),
    }),
    {
      name: 'gtathens-v2',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ settings: s.settings }),
    },
  ),
)

export default useGameStore

// One-shot toast id source (module scope, above the store would hoist fine).
let toastSeq = 0

// Headless QA seam (scripts/smoke.mjs): ONE stable object rewritten only when
// the store actually changes (money/health changes are rare events), so the
// test can assert on the economy without re-render coupling.
if (typeof window !== 'undefined') {
  const storeSnap = { money: 0, health: 100, equipped: 'fists', kills: 0, guns: 0, mag: 0 }
  useGameStore.subscribe((s) => {
    storeSnap.money = s.money
    storeSnap.health = s.health
    storeSnap.equipped = s.equipped
    storeSnap.kills = s.killCount
    storeSnap.guns = s.weapons.length
    const w = s.weapons.find((x) => x.id === s.equipped)
    storeSnap.mag = w ? w.mag : 0
  })
  window.__gtathensStore = storeSnap
  // QA seam (scripts/smoke.mjs): hand the player a gun through the SAME action
  // a weapon pickup uses, so the headless shoot test exercises the real firing
  // path instead of faking it. Never called by game code.
  window.__gtathensGive = (id, ammo = 90) => {
    useGameStore.getState().giveWeapon(id, ammo)
    const s = useGameStore.getState()
    return { equipped: s.equipped, guns: s.weapons.length, mag: s.weapons[0] ? s.weapons[0].mag : 0 }
  }
}
