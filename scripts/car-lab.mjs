// Render every GLB in /public/models/cars/ with the game's own three.js
// GLTFLoader in headless Chrome (CDP), two angles per car, one contact sheet.
// Also dumps post-load world-space bboxes (authoritative numbers, node
// transforms included) to scripts/carlab-boxes.json.
//   node scripts/car-lab.mjs
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8123
const CDP_PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------ static server --------------------------- */
const MIME = {
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/__carlab') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(LAB_HTML_source || LAB_HTML)
    return
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const file = path.join(ROOT, rel)
  const allowed = file.startsWith(ROOT) && existsSync(file) &&
    (file.includes(`${ROOT}${path.sep}node_modules`) || file.includes(`${ROOT}${path.sep}public`))
  if (!allowed) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
  res.end(readFileSync(file))
})

/* -------------------------------- lab page ------------------------------ */
// FILES injected by main() into LAB_HTML (kept here for readability).
let CAR_FILES = []
const LAB_HTML = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">
{ "imports": {
  "three": "/node_modules/three/build/three.module.js",
  "three/addons/": "/node_modules/three/examples/jsm/"
} }
</script></head><body style="margin:0;background:#101216">
<canvas id="sheet"></canvas>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
window.__carlabReady = true
window.__carlabBoxes = {}
window.__carlabErr = []

const FILES = ${'{{FILES}}'}
const CW = 320, CH = 240, COLS = 6
const rows = Math.ceil(FILES.length * 2 / COLS)
const sheet = document.getElementById('sheet')
sheet.width = CW * COLS; sheet.height = CH * rows
const ctx = sheet.getContext('2d')
ctx.fillStyle = '#101216'; ctx.fillRect(0, 0, sheet.width, sheet.height)

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(CW, CH)
renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)
renderer.domElement.style.position = 'absolute'
renderer.domElement.style.left = '-9999px'

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x14181f)
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a3630, 1.1))
const sun = new THREE.DirectionalLight(0xffffff, 1.6)
sun.position.set(6, 10, 4)
scene.add(sun)
scene.add(new THREE.GridHelper(20, 20, 0x2c5f2c, 0x24401f))

const cam = new THREE.PerspectiveCamera(40, CW / CH, 0.05, 200)
const loader = new GLTFLoader()
const box3 = new THREE.Box3()

const renderOne = (gltf, name, viewIdx) => {
  const obj = gltf.scene
  scene.add(obj)
  obj.updateMatrixWorld(true)
  box3.setFromObject(obj)
  const size = box3.getSize(new THREE.Vector3())
  const c = box3.getCenter(new THREE.Vector3())
  window.__carlabBoxes[name] = {
    min: box3.min.toArray().map((v) => +v.toFixed(3)),
    max: box3.max.toArray().map((v) => +v.toFixed(3)),
    size: size.toArray().map((v) => +v.toFixed(3)),
    center: c.toArray().map((v) => +v.toFixed(3)),
  }
  const dist = Math.max(size.x, size.y, size.z) * 2.6
  const yaw = viewIdx === 0 ? 0.7 : 0.7 + Math.PI
  const pitch = 0.42
  cam.position.set(
    c.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    c.y + Math.sin(pitch) * dist,
    c.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  )
  cam.lookAt(c.x, c.y - size.y * 0.09, c.z)
  renderer.render(scene, cam)
  const cell = viewIdx === 0 ? FILES.indexOf(name) : FILES.length + FILES.indexOf(name)
  const col = cell % COLS, row = Math.floor(cell / COLS)
  ctx.drawImage(renderer.domElement, col * CW, row * CH, CW, CH)
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(col * CW, row * CH, CW, 26)
  ctx.fillStyle = '#9fd6ff'
  ctx.font = '13px monospace'
  ctx.fillText(name + '  ' + size.toArray().map((v) => v.toFixed(2)).join('/'), col * CW + 6, row * CH + 18)
  scene.remove(obj)
}

let i = 0
const next = () => {
  if (i >= FILES.length) { window.__carlabDone = true; return }
  const name = FILES[i]
  loader.load('/public/models/cars/' + name,
    (gltf) => {
      try {
        renderOne(gltf, name, 0)
        renderOne(gltf, name, 1)
      } catch (e) { window.__carlabErr.push(name + ': ' + (e && e.message)) }
      i += 1
      next()
    },
    undefined,
    (e) => { window.__carlabErr.push(name + ': load error ' + e); i += 1; next() },
  )
}
next()
</script></body></html>`

/* ------------------------------ CDP plumbing ---------------------------- */
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
  const profile = path.join(os.tmpdir(), `carlab-${Date.now()}`)
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
  return { browser, page: new Cdp(new WebSocket(pageWs)) }
}

/* --------------------------------- main --------------------------------- */
const main = async () => {
  const keepAlive = setInterval(() => {}, 1000)
  const watchdog = setTimeout(() => {
    console.error('TIMEOUT: car-lab exceeded 150s')
    process.exit(1)
  }, 150000)
  // file list straight from disk, sorted
  const { readdirSync } = await import('node:fs')
  CAR_FILES = readdirSync(path.join(ROOT, 'public/models/cars'))
    .filter((f) => f.endsWith('.glb')).sort()
  const html = LAB_HTML.replace('{{FILES}}', JSON.stringify(CAR_FILES))
  // swap the template's file list in place (server serves LAB_HTML)
  LAB_HTML_source = html
  await new Promise((r) => server.listen(PORT, r))
  await ensureChrome()
  const { browser, page } = await openPage()
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1440, deviceScaleFactor: 1, mobile: false })
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/__carlab` })
  let state = '{"done":false}'
  for (let i = 0; i < 120; i += 1) {
    await sleep(1000)
    state = await page.evaluate('JSON.stringify({done: !!window.__carlabDone, ready: !!window.__carlabReady, err: window.__carlabErr})')
    const s = JSON.parse(state)
    if (s.done || (s.err && s.err.length)) break
  }
  const boxesJson = await page.evaluate('JSON.stringify(window.__carlabBoxes || {})')
  writeFileSync(path.join(ROOT, 'scripts/carlab-boxes.json'), boxesJson)
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(ROOT, 'scripts/cars-lab-sheet.png'), Buffer.from(shot.data, 'base64'))
  const boxes = JSON.parse(boxesJson)
  for (const [name, b] of Object.entries(boxes)) {
    console.log(`${name}: size=${b.size.join(' x ')} min=[${b.min.join(', ')}] center=[${b.center.join(', ')}]`)
  }
  console.log('page state: ' + state)
  killChrome()
  server.close()
  clearTimeout(watchdog)
  clearInterval(keepAlive)
  console.log('wrote scripts/cars-lab-sheet.png + scripts/carlab-boxes.json')
  process.exit(0)
}
let LAB_HTML_source = null
main().catch((e) => { console.error(e); killChrome(); process.exit(1) })

