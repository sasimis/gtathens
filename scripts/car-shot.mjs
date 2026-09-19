// In-game car screenshots: boots the real game headless (CDP), clicks PLAY,
// teleports the player in front-left of a few parked cars and captures each
// so the new GLB models can be SEEN in the actual game (orientation on the
// ground, textures, collider alignment).
//   node scripts/car-shot.mjs [url] [spots...]
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const URL_ = process.argv[2] || 'http://127.0.0.1:5173/'
const SPOTS = (process.argv.slice(3).length ? process.argv.slice(3) : ['0', '3', '7', '12', '17', '22']).map(Number)
const CDP_PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.handlers = []
    this.ready = new Promise((resolve, reject) => {
      if (ws.readyState === 1) resolve()
      else {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', () => reject(new Error('websocket failed to open')))
      }
    })
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const h of this.handlers) h(msg)
      }
    })
  }
  async send(method, params = {}) {
    await this.ready
    const id = ++this.nextId
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  on(fn) { this.handlers.push(fn) }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) return { error: r.exceptionDetails.text }
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

const devtoolsUp = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch { return false }
}

let chromeHandle = { proc: null, profile: null }
const ensureChrome = async () => {
  if (await devtoolsUp()) return chromeHandle
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!exe) throw new Error('no Chrome/Edge found — set CHROME_PATH')
  const profile = path.join(os.tmpdir(), `carshot-${Date.now()}`)
  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' })
  chromeHandle = { proc, profile }
  for (let i = 0; i < 60; i += 1) {
    if (await devtoolsUp()) return chromeHandle
    await sleep(250)
  }
  throw new Error(`chrome never exposed devtools on ${CDP_PORT}`)
}
const killChrome = () => {
  const { proc, profile } = chromeHandle
  if (proc) { try { proc.kill() } catch (e) { /* ignore */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  chromeHandle = { proc: null, profile: null }
}

const openPage = async () => {
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
  const browser = new Cdp(new WebSocket(version.webSocketDebuggerUrl))
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  let pageWs = null
  for (let i = 0; i < 40 && !pageWs; i += 1) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    pageWs = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl || null
    if (!pageWs) await sleep(100)
  }
  if (!pageWs) throw new Error('could not find page target websocket')
  return { page: new Cdp(new WebSocket(pageWs)) }
}

const snap = async (page, name) => {
  const r = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(HERE, `shot-car-${name}.png`), Buffer.from(r.data, 'base64'))
  console.log(`saved shot-car-${name}.png`)
}

const main = async () => {
  const keepAlive = setInterval(() => {}, 1000)
  const watchdog = setTimeout(() => { console.error('TIMEOUT: car-shot > 110s'); process.exit(1) }, 110000)
  await ensureChrome()
  const { page } = await openPage()
  page.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.error('EXC: ' + ((d.exception && d.exception.description) || d.text))
    }
  })
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.navigate', { url: URL_ })
  let booted = false
  for (let i = 0; i < 40 && !booted; i += 1) {
    await sleep(1000)
    booted = await page.evaluate(`!!document.querySelector('canvas') && Array.from(document.querySelectorAll('button')).some((b) => /play/i.test(b.textContent))`)
  }
  if (!booted) { console.error('menu never appeared'); process.exit(1) }
  await page.evaluate(`Array.from(document.querySelectorAll('button')).find((b) => /play/i.test(b.textContent)).click()`)
  await sleep(4000)
  const state = await page.evaluate(`JSON.stringify({
    cars: typeof window.__gtathensCars !== 'undefined',
    tp: typeof window.__gtathensTp === 'function',
    player: !!window.__gtathensPlayer,
  })`)
  console.log('state: ' + state)
  // per-spot ids from the LIVE QA hook. A bare dynamic import of
  // crashManager.js can resolve a FRESH module instance after an HMR
  // invalidation and return an empty spotsCache (this printed [] before),
  // while the mounted component's hook always carries the real spots.
  const ids = await page.evaluate(`JSON.stringify(
    Array.from({ length: window.__gtathensCars.count() }, (_, i) => {
      const s = window.__gtathensCars.spot(i)
      return s ? (s.id || null) : null
    })
  )`)
  const idList = JSON.parse(ids)
  console.log('spot ids: ' + ids)
  for (const i of SPOTS) {
    const spot = await page.evaluate(`JSON.stringify(window.__gtathensCars.spot(${i}))`)
    if (!spot) { console.log(`spot ${i}: none`); continue }
    const s = JSON.parse(spot)
    // stand ahead-left of the car so the chase camera frames its front 3/4
    const a = (s.rot || 0) + 0.8
    const px = s.x + Math.sin(a) * 5.5
    const pz = s.z + Math.cos(a) * 5.5
    const yaw = Math.atan2(s.x - px, s.z - pz)
    await page.evaluate(`window.__gtathensTp(${px}, ${pz}, ${yaw})`)
    await sleep(1600)
    await snap(page, `spot${i}-${String(idList[i] || 'car').replace(/[^a-z0-9-]/gi, '_')}`)
  }
  killChrome()
  clearTimeout(watchdog)
  clearInterval(keepAlive)
  console.log('done')
  process.exit(0)
}

main().catch((e) => { console.error(e); killChrome(); process.exit(1) })

