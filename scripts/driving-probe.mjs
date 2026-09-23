// Headless probe for the DRIVING TEST SCENE (driving.html).
//
//   cd workspace && node scripts/driving-probe.mjs [url]
//
// Boots the real page in headless Chrome over CDP, captures uncaught
// exceptions (with stacks) + console errors, then drives the ACTUAL enter ->
// accelerate -> exit loop with real key events and prints the state. Run this
// after every driving-tuning change: it proves the scene renders (no black
// screen) and that input still reaches CarDriver.
//
// Default URL uses `localhost` on purpose — Vite 5 binds `::1` only, where
// `127.0.0.1` refuses the connection.
import { existsSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPORT = fileURLToPath(new URL('./driving-probe.txt', import.meta.url))
writeFileSync(REPORT, '')
const mirror = (orig) => (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  orig(line)
  try { appendFileSync(REPORT, line + '\r\n') } catch { /* ignore */ }
}
console.log = mirror(console.log.bind(console))
console.error = mirror(console.error.bind(console))

const PORT = 9222
const TARGET_URL = process.argv[2] || 'http://localhost:5173/driving.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdpFetch = async (p, init) => (await fetch(`http://127.0.0.1:${PORT}${p}`, init)).json()

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.onmessage = null
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method && this.onmessage) this.onmessage(msg)
    })
    ws.addEventListener('open', () => { this.wsOpen = true })
  }
  async send(method, params = {}) {
    for (let i = 0; i < 60 && !this.wsOpen; i += 1) await sleep(50)
    const id = ++this.nextId
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.ws.send(JSON.stringify({ id, method, params }))
    return p
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
    return r.result.value
  }
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)

let chromeHandle = { proc: null, profile: null }
const devtoolsUp = async () => {
  try {
    await cdpFetch('/json/version', { signal: AbortSignal.timeout(1500) })
    return true
  } catch { return false }
}
const ensureChrome = async () => {
  if (await devtoolsUp()) return
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!exe) throw new Error('no Chrome/Edge found')
  const profile = path.join(os.tmpdir(), `gta-driving-${Date.now()}`)
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, '--enable-unsafe-swiftshader', '--no-first-run', '--mute-audio', '--window-size=1280,760', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  chromeHandle = { proc, profile }
  for (let i = 0; i < 60; i += 1) {
    if (await devtoolsUp()) return
    await sleep(250)
  }
  throw new Error('chrome never exposed devtools')
}
const killChrome = () => {
  const { proc, profile } = chromeHandle
  if (proc) { try { proc.kill() } catch { /* ignore */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ } }
}

// Real key press/release. Our scene's listeners (DriveTestPlayer + CarDriver)
// attach to `window`, so a synthetic KeyboardEvent carrying `code` works.
const key = (page, type, code, keyName) => page.evaluate(
  `window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { code: ${JSON.stringify(code)}, key: ${JSON.stringify(keyName)}, bubbles: true })); true`,
)

const BODY_TYPES = `(function(){
  var h = window.__gtathensCars; if (!h) return 'no hook'
  var out = []
  for (var i = 0; i < h.count(); i++) out.push(i + ':' + h.btype(i))
  return out.join(' ')
})()`

const main = async () => {
  const keepAlive = setInterval(() => {}, 1000)
  const watchdog = setTimeout(() => { console.error('TIMEOUT'); killChrome(); process.exit(1) }, 120000)
  await ensureChrome()
  const version = await cdpFetch('/json/version')
  const browser = new Cdp(new WebSocket(version.webSocketDebuggerUrl))
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  await sleep(300)
  const list = await cdpFetch('/json/list')
  const pageWs = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl
  const page = new Cdp(new WebSocket(pageWs))

  const exceptions = new Map()
  const consoleErrors = []
  page.onmessage = (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      const text = d.exception?.description || d.text || 'unknown'
      const frames = (d.stackTrace?.callFrames || []).slice(0, 6).map(
        (f) => `${f.functionName || '<anon>'} @ ${f.url.split('/').pop()}:${f.lineNumber + 1}`,
      )
      const prev = exceptions.get(text)
      if (prev) prev.count += 1
      else exceptions.set(text, { count: 1, frames })
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  }
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: TARGET_URL })
  console.log('navigated: ' + TARGET_URL)
  await sleep(9000)

  console.log('\n--- boot state ---')
  console.log(await page.evaluate(`JSON.stringify({
    canvas: !!document.querySelector('canvas'),
    rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
    hookCars: !!window.__gtathensCars,
    hookTp: typeof window.__gtathensTp,
    physics: !!window.__gtathensPhysics,
    phase: window.__gtathensCars ? window.__gtathensCars.phase() : null,
    cars: window.__gtathensCars ? window.__gtathensCars.count() : null,
    player: window.__gtathensPlayer ? { x: +window.__gtathensPlayer.x.toFixed(2), y: +window.__gtathensPlayer.y.toFixed(2), z: +window.__gtathensPlayer.z.toFixed(2) } : null,
    cam: window.__gtathensCam ? { x: +window.__gtathensCam.x.toFixed(2), y: +window.__gtathensCam.y.toFixed(2), z: +window.__gtathensCam.z.toFixed(2) } : null
  })`))

  // Is the canvas actually DRAWING? Read the framebuffer back — an all-black
  // row is the black-screen signature, a sky/asphalt row is not.
  console.log('pixels(centre row): ' + await page.evaluate(`(function(){
    var c = document.querySelector('canvas')
    if (!c) return 'no canvas'
    var gl = c.getContext('webgl2') || c.getContext('webgl')
    if (!gl) return 'no gl ctx'
    try {
      var w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
      var lum = []
      for (var i = 0; i < 5; i++) {
        var x = Math.floor(w * (0.2 + 0.15 * i)), y = Math.floor(h * 0.5)
        var one = new Uint8Array(4)
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one)
        lum.push(one[0] + ',' + one[1] + ',' + one[2])
      }
      return 'size ' + w + 'x' + h + ' :: ' + lum.join(' | ')
    } catch (e) { return 'readPixels failed: ' + e.message }
  })()`))

  console.log('body types (0=dynamic 1=fixed): ' + await page.evaluate(BODY_TYPES))

  console.log('\n--- enter car 0 (teleport beside it, real F) ---')
  console.log('tp: ' + await page.evaluate(`JSON.stringify(window.__gtathensTp ? window.__gtathensTp(2.6, 0.6, 0) : 'no tp')`))
  await sleep(400)
  await key(page, 'keydown', 'KeyF', 'f')
  await sleep(120)
  await key(page, 'keyup', 'KeyF', 'f')
  await sleep(900)
  console.log('driving = ' + await page.evaluate('window.__gtathensCars ? String(window.__gtathensCars.driving()) : "no hook"'))
  console.log('body types after: ' + await page.evaluate(BODY_TYPES))

  const before = await page.evaluate('JSON.stringify(window.__gtathensCars.pos(0))')
  console.log('\n--- hold W 2.4 s ---')
  await key(page, 'keydown', 'KeyW', 'w')
  await sleep(2400)
  await key(page, 'keyup', 'KeyW', 'w')
  await sleep(400)
  const after = await page.evaluate('JSON.stringify(window.__gtathensCars.pos(0))')
  console.log('pos before: ' + before)
  console.log('pos after:  ' + after)
  const moved = (() => {
    try {
      const a = JSON.parse(before), b = JSON.parse(after)
      return a && b ? Math.hypot(b.x - a.x, b.z - a.z) : null
    } catch { return null }
  })()
  console.log('displacement: ' + (moved == null ? 'n/a' : moved.toFixed(2) + ' m'))
  console.log(moved != null && moved > 3 ? 'DRIVE TEST: PASS' : 'DRIVE TEST: FAIL')
  console.log('cam after drive: ' + await page.evaluate('JSON.stringify(window.__gtathensCam ? { x:+window.__gtathensCam.x.toFixed(1), z:+window.__gtathensCam.z.toFixed(1) } : null)'))

  console.log('\n--- exit car (real F) ---')
  // Log every respawn/driving write the exit makes (definitive: what did
  // exitCar hand over, and did the on-foot player ever see it?).
  console.log('subscribe: ' + await page.evaluate(`(async function(){
    try {
      if (!window.__respawnLog) {
        window.__respawnLog = []
        var store = (await import('/src/store/useGameStore.js')).default
        store.subscribe(function (s) {
          window.__respawnLog.push({ t: Math.round(performance.now()), respawn: s.respawn, driving: s.driving })
        })
      }
      return 'ok'
    } catch (e) { return 'failed: ' + e.message }
  }())`))
  await key(page, 'keydown', 'KeyF', 'f')
  await sleep(120)
  await key(page, 'keyup', 'KeyF', 'f')
  await sleep(900)
  console.log('respawnLog: ' + await page.evaluate('JSON.stringify(window.__respawnLog || [])'))
  console.log('playerSpawn used: ' + await page.evaluate('JSON.stringify(window.__gtathensPlayerSpawn || null)'))
  // Track the freshly-exited player over ~1 s: does it START beside the car and
  // then get yanked back to the origin?
  for (const ms of [60, 150, 400]) {
    await sleep(ms)
    console.log(`  player +${ms}ms: ` + await page.evaluate('JSON.stringify(window.__gtathensPlayer ? { x:+window.__gtathensPlayer.x.toFixed(2), y:+window.__gtathensPlayer.y.toFixed(2), z:+window.__gtathensPlayer.z.toFixed(2) } : null)'))
  }
  // Does an explicit teleport STICK? (distinguishes a one-shot mount bug from
  // something continuously forcing the position back to the origin)
  console.log('tp back to car: ' + await page.evaluate('JSON.stringify(window.__gtathensTp ? window.__gtathensTp(-2.6, 24, 0) : null)'))
  await sleep(400)
  console.log('  after tp: ' + await page.evaluate('JSON.stringify(window.__gtathensPlayer ? { x:+window.__gtathensPlayer.x.toFixed(2), y:+window.__gtathensPlayer.y.toFixed(2), z:+window.__gtathensPlayer.z.toFixed(2) } : null)'))
  const drivingNow = await page.evaluate('window.__gtathensCars ? window.__gtathensCars.driving() : "x"')
  console.log('driving after exit = ' + String(drivingNow))
  console.log('car0 pos after exit: ' + await page.evaluate('JSON.stringify(window.__gtathensCars.pos(0))'))
  console.log('player after exit: ' + await page.evaluate('JSON.stringify(window.__gtathensPlayer ? { x:+window.__gtathensPlayer.x.toFixed(2), z:+window.__gtathensPlayer.z.toFixed(2) } : null)'))
  // Deep diag: the store's respawn handoff vs the live car body vs the player.
  console.log('diag: ' + await page.evaluate(`(async function(){
    try {
      var store = (await import('/src/store/useGameStore.js')).default
      var cm = await import('/src/components/car-modules/crashManager.js')
      var st = store.getState()
      var rb = cm.crash.bodies[0]
      var t = rb && rb.translation ? rb.translation() : null
      return JSON.stringify({
        respawn: st.respawn,
        driving: st.driving,
        livePos0: cm.crash.livePos[0] || null,
        body0: t ? { x: +t.x.toFixed(2), z: +t.z.toFixed(2) } : null,
        player: window.__gtathensPlayer ? { x: +window.__gtathensPlayer.x.toFixed(2), z: +window.__gtathensPlayer.z.toFixed(2) } : null
      })
    } catch (e) { return 'diag failed: ' + e.message }
  }())`))
  console.log('EXIT TEST: ' + (drivingNow === null ? 'PASS' : 'FAIL'))

  try {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(fileURLToPath(new URL('./driving-shot.png', import.meta.url)), Buffer.from(shot.data, 'base64'))
    console.log('screenshot: scripts/driving-shot.png')
  } catch { /* ignore */ }

  console.log('\n--- uncaught exceptions (deduped) ---')
  if (exceptions.size === 0) console.log('none')
  for (const [msg, info] of exceptions) {
    console.log(`x${info.count}  ${msg.split('\n')[0]}`)
    for (const f of info.frames) console.log(`        ${f}`)
  }
  console.log('\n--- console errors ---')
  const uniq = [...new Set(consoleErrors)]
  if (uniq.length === 0) console.log('none')
  for (const e of uniq.slice(0, 15)) console.log('  ' + e)

  await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  clearInterval(keepAlive)
  clearTimeout(watchdog)
  try { page.ws.close() } catch { /* ignore */ }
  try { browser.ws.close() } catch { /* ignore */ }
  killChrome()
  await sleep(200)
  process.exitCode = 0
}

main().catch((err) => {
  console.error('DRIVING PROBE FAILED: ' + err.message)
  killChrome()
  process.exitCode = 1
})


