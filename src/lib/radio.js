// Greek Radio Stations & Audio Manager
// Streams live Greek radio stations via HTML5 Audio element.

export const RADIO_STATIONS = [
  {
    id: 'off',
    name: 'Radio Off',
    freq: 'OFF',
    genre: 'Mute',
    url: null,
  },
  {
    id: 'era-sport',
    name: 'ERA Sport',
    freq: '101.8 FM',
    genre: 'Sports & News',
    url: 'https://radiostreaming.ert.gr/ert-erasport',
  },
  {
    id: 'era-deftero',
    name: 'ERA Deftero',
    freq: '103.7 FM',
    genre: 'Greek Music',
    url: 'https://radiostreaming.ert.gr/ert-deftero',
  },
  {
    id: 'era-kosmos',
    name: 'ERA Kosmos',
    freq: '93.6 FM',
    genre: 'World & Pop',
    url: 'https://radiostreaming.ert.gr/ert-kosmos',
  },
  {
    id: 'music892',
    name: 'Music 89.2',
    freq: '89.2 FM',
    genre: 'Top 40 & Dance',
    url: 'https://netradio.live24.gr/music892',
  },
  {
    id: 'menta88',
    name: 'Menta 88.0',
    freq: '88.0 FM',
    genre: 'Entechno Greek',
    url: 'https://netradio.live24.gr/menta88ath',
  },
  {
    id: 'metropolis955',
    name: 'Metropolis 95.5',
    freq: '95.5 FM',
    genre: 'Sports Talk',
    url: 'https://metromedia.live24.gr/metropolis955thess',
  },
  {
    id: 'athensrock969',
    name: 'Athens Rock',
    freq: '96.9 FM',
    genre: 'Rock & Metal',
    url: 'https://az10.yesstreaming.net/radio/8060/radio.mp3',
  },
  {
    id: 'kosmosjazz',
    name: 'Kosmos Jazz',
    freq: 'WEB',
    genre: 'Smooth Jazz',
    url: 'https://radiostreaming.ert.gr/ert-webjazz',
  },
  {
    id: 'focus1036',
    name: 'Focus FM',
    freq: '103.6 FM',
    genre: 'Greek Talk',
    url: 'https://ice.greekstream.net/focusfm',
  },
  {
    id: 'era-proto',
    name: 'ERA Proto',
    freq: '91.6 FM',
    genre: 'News & Current Affairs',
    url: 'https://radiostreaming.ert.gr/ert-proto',
  },
]

class RadioAudio {
  constructor() {
    this.audio = null
    this.currentIndex = 0
    this.volume = 1
    this.status = 'OFF' // 'OFF' | 'CONNECTING' | 'PLAYING' | 'ERROR'
    this.listeners = new Set()
  }

  getAudioElement() {
    if (typeof window === 'undefined') return null
    if (!this.audio) {
      this.audio = new Audio()
      this.audio.preload = 'none'

      this.audio.addEventListener('playing', () => {
        this.setStatus('PLAYING')
      })
      this.audio.addEventListener('waiting', () => {
        if (this.currentIndex !== 0) this.setStatus('CONNECTING')
      })
      this.audio.addEventListener('stalled', () => {
        if (this.currentIndex !== 0) this.setStatus('CONNECTING')
      })
      this.audio.addEventListener('error', (e) => {
        console.warn('Radio stream error:', e)
        if (this.currentIndex !== 0) this.setStatus('ERROR')
      })
      this.audio.addEventListener('pause', () => {
        if (this.currentIndex === 0) this.setStatus('OFF')
      })
    }
    return this.audio
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  notify() {
    for (const fn of this.listeners) {
      try {
        fn({ status: this.status, index: this.currentIndex, station: RADIO_STATIONS[this.currentIndex] })
      } catch (e) {
        console.error(e)
      }
    }
  }

  setStatus(status) {
    if (this.status !== status) {
      this.status = status
      this.notify()
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol) || 0))
    const el = this.getAudioElement()
    if (el) {
      el.volume = this.volume
    }
  }

  playStation(index) {
    const el = this.getAudioElement()
    if (!el) return

    const idx = Math.max(0, Math.min(RADIO_STATIONS.length - 1, Number(index) || 0))
    this.currentIndex = idx

    const station = RADIO_STATIONS[idx]

    if (idx === 0 || !station.url) {
      el.pause()
      el.src = ''
      this.setStatus('OFF')
      return
    }

    this.setStatus('CONNECTING')
    el.pause()
    el.src = station.url
    el.volume = this.volume

    const playPromise = el.play()
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          this.setStatus('PLAYING')
        })
        .catch((err) => {
          console.warn('Radio autoplay error:', err)
          this.setStatus('ERROR')
        })
    }
  }

  pause() {
    const el = this.getAudioElement()
    if (el) {
      el.pause()
    }
  }

  resume() {
    if (this.currentIndex !== 0) {
      const el = this.getAudioElement()
      if (el && el.src) {
        el.play().catch(() => {})
      }
    }
  }

  stop() {
    this.currentIndex = 0
    const el = this.getAudioElement()
    if (el) {
      el.pause()
      el.src = ''
    }
    this.setStatus('OFF')
  }
}

export const radioAudio = new RadioAudio()
if (typeof window !== 'undefined') {
  window.__gtathensRadio = radioAudio
}
