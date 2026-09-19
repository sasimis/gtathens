// Greek Radio Stations & Audio Manager
// Streams live Greek radio stations via HTML5 Audio element.

export const RADIO_STATIONS = [
  {
    id: 'off',
    name: 'Radio Off',
    freq: 'OFF',
    genre: 'Mute',
    color: '#3a475a',
    url: null,
  },
  {
    id: 'era-sport',
    name: 'ERA Sport',
    freq: '101.8 FM',
    genre: 'Sports & News',
    color: '#0052cc',
    url: 'https://radiostreaming.ert.gr/ert-erasport',
  },
  {
    id: 'era-deftero',
    name: 'ERA Deftero',
    freq: '103.7 FM',
    genre: 'Greek Music',
    color: '#172b4d',
    url: 'https://radiostreaming.ert.gr/ert-deftero',
  },
  {
    id: 'era-kosmos',
    name: 'ERA Kosmos',
    freq: '93.6 FM',
    genre: 'World & Pop',
    color: '#6554c0',
    url: 'https://radiostreaming.ert.gr/ert-kosmos',
  },
  {
    id: 'music892',
    name: 'Music 89.2',
    freq: '89.2 FM',
    genre: 'Top 40 & Dance',
    color: '#ff5630',
    url: 'https://netradio.live24.gr/music892',
  },
  {
    id: 'red963',
    name: 'Red 96.3',
    freq: '96.3 FM',
    genre: 'Classic Rock',
    color: '#c53030',
    url: 'https://frontstage.live24.gr/redfm',
  },
  {
    id: 'enlefko877',
    name: 'En Lefko',
    freq: '87.7 FM',
    genre: 'Indie & Funk',
    color: '#2b6cb0',
    url: 'https://frontstage.live24.gr/enlefko877',
  },
  {
    id: 'melodia992',
    name: 'Melodia',
    freq: '99.2 FM',
    genre: 'Entechno',
    color: '#b7791f',
    url: 'https://frontstage.live24.gr/melodia',
  },
  {
    id: 'rythmos949',
    name: 'Rythmos 94.9',
    freq: '94.9 FM',
    genre: 'Greek Hits',
    color: '#dd6b20',
    url: 'https://s2.themediacdn.com/rythmos949',
  },
  {
    id: 'menta88',
    name: 'Menta 88.0',
    freq: '88.0 FM',
    genre: 'Greek Songs',
    color: '#006644',
    url: 'https://netradio.live24.gr/menta88ath',
  },
  {
    id: 'realfm978',
    name: 'Real FM',
    freq: '97.8 FM',
    genre: 'News & Talk',
    color: '#2c5282',
    url: 'https://realfm.live24.gr/realfm',
  },
  {
    id: 'pepper966',
    name: 'Pepper 96.6',
    freq: '96.6 FM',
    genre: 'Eclectic Pop',
    color: '#6b46c1',
    url: 'https://pepper.live24.gr/pepper966',
  },
  {
    id: 'diesi1013',
    name: 'Diesi 101.3',
    freq: '101.3 FM',
    genre: 'Acoustic Greek',
    color: '#d69e2e',
    url: 'https://diesi.live24.gr/diesi1013',
  },
  {
    id: 'athensrock969',
    name: 'Athens Rock',
    freq: '96.9 FM',
    genre: 'Rock & Metal',
    color: '#1a202c',
    url: 'https://az10.yesstreaming.net/radio/8060/radio.mp3',
  },
  {
    id: 'metropolis955',
    name: 'Metropolis',
    freq: '95.5 FM',
    genre: 'Sports Talk',
    color: '#0747a6',
    url: 'https://metromedia.live24.gr/metropolis955thess',
  },
  {
    id: 'focus1036',
    name: 'Focus FM',
    freq: '103.6 FM',
    genre: 'Greek Talk',
    color: '#ff8b00',
    url: 'https://ice.greekstream.net/focusfm',
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
