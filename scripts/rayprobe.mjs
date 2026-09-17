// One-off diagnostic: are PED CAPSULES hittable by world.castRay at all?
// The smoke shoot test shows bullets passing through peds (toi = ground far
// beyond them). This probe boots the real game, then from the page:
//   1. sanity: ray straight down -> ground toi
//   2. ray from 3 m straight at a living ped's rb center (horizontal, y=0.95)
//   3. same but from the real camera position toward the ped
// and prints each toi. A ped hit at (1) reads toi ~2.65 (3 - 0.35 capsule r).
// Reuses smoke.mjs's CDP plumbing (copied — smoke.mjs runs main() on import).
import { existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = 9222
const TARGET_URL = process.argv[2] || 'http://127.0.0.1:5173/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cdpFetch = async (p, init) => (await fetch(`http://127.0.0.1:${PORT}${p}`, init)).json()

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page eval failed')
    return r.result.value
  }
}

const devtoolsUp = async () => {
  try {
    await cdpFetch('/json/version', { signal: AbortSignal.timeout(1500) })
    return true
  } catch { return false }
}

let chromeHandle = { proc: null, profile: null }
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const ensureChrome = async () => {
  if (await devtoolsUp()) return chromeHandle
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!exe) throw new Error('no Chrome/Edge found')
  const profile = path.join(os.tmpdir(), `gta-rayprobe-${Date.now()}`)
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, '--enable-unsafe-swiftshader', '--no-first-run', '--mute-audio', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  chromeHandle = { proc, profile }
  for (let i = 0; i < 60; i += 1) {
    if (await devtoolsUp()) return chromeHandle
    await sleep(250)
  }
  throw new Error('chrome never exposed devtools')
}
const killChrome = () => {
  const { proc, profile } = chromeHandle
  if (proc) { try { proc.kill() } catch { /* ignore */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ } }
}

const PROBE = `(async function () {
  const P = window.__gtathensPhysics
  const N = window.__gtathensNpcs
  if (!P || !P.world || !N) return JSON.stringify({ error: 'hooks missing' })
  const world = P.world
  let rapier = P.rapier
  if (!rapier) {
    for (const spec of ['/@id/@dimforge/rapier3d-compat', '/node_modules/.vite/deps/@dimforge_rapier3d-compat.js']) {
      try { rapier = await import(spec); break } catch (e) { /* try next */ }
    }
  }
  if (!rapier) return JSON.stringify({ error: 'rapier module unresolvable from page' })
  const alive = N.aliveCount()
  const idx = N.nearest(0, 0)
  if (idx < 0) return JSON.stringify({ error: 'no living ped', alive })
  const ped = N.ped(idx)
  const out = { alive, idx, ped, casts: [] }
  const cast = (ox, oy, oz, dx, dy, dz, label) => {
    let ray = null
    try { ray = new rapier.Ray({ x: ox, y: oy, z: oz }, { x: dx, y: dy, z: dz }) } catch (e) { out.casts.push({ label, error: 'ray ctor' }); return }
    let res = null
    try { res = world.castRay(ray, 200, true) } catch (e) { out.casts.push({ label, error: 'cast threw ' + e.message }) }
    try { if (ray && ray.free) ray.free() } catch (e2) {}
    if (res) {
      let desc = ''
      try {
        const col = res.collider
        if (col) {
          const par = col.parent()
          desc = 'body#' + (par ? par.handle : '?')
          try { const t = par ? par.translation() : null; if (t) desc += '@(' + t.x.toFixed(1) + ',' + t.y.toFixed(1) + ',' + t.z.toFixed(1) + ')' } catch (e3) {}
        }
      } catch (e4) { desc = 'collider desc failed' }
      out.casts.push({ label, toi: +(res.toi != null ? res.toi : res.timeOfImpact).toFixed(3), hit: desc })
    } else out.casts.push({ label, toi: null })
  }
  cast(ped.x, 5, ped.z, 0, -1, 0, 'down@ped(y5->ground)')
  cast(ped.x - 3, ped.y, ped.z, 1, 0, 0, 'horizontal 3m at chest')
  cast(ped.x - 1.25, ped.y, ped.z, 1, 0, 0, 'horizontal 1.25m at chest')
  cast(ped.x - 2, ped.y + 2, ped.z, 2, -2, 0, 'diagonal from behind/above')
  cast(ped.x + 10, 5, ped.z + 10, 0, -1, 0, 'down 10m away (ground)')
  return JSON.stringify(out)
}())`

const main = async () => {
  const keepAlive = setInterval(() => {}, 1000)
  const watchdog = setTimeout(() => { console.error('TIMEOUT'); process.exit(1) }, 90000)
  await ensureChrome()
  const version = await cdpFetch('/json/version')
  const browser = new Cdp(new WebSocket(version.webSocketDebuggerUrl))
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  await sleep(300)
  const list = await cdpFetch('/json/list')
  const pageWs = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl
  const page = new Cdp(new WebSocket(pageWs))
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: TARGET_URL })
  await sleep(10000)
  await page.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Play'); if (b) b.click(); return !!b })()`)
  await sleep(6000)
  console.log('boot: ' + await page.evaluate(`JSON.stringify({ canvas: !!document.querySelector('canvas'), ped: !!window.__gtathensNpcs, phys: !!window.__gtathensPhysics, nav: window.__gtathensNav ? { ready: window.__gtathensNav.ready(), polys: window.__gtathensNav.polys(), ms: Math.round(window.__gtathensNav.ms() || 0), prisms: window.__gtathensNav.prisms() } : null, navWalk: window.__gtathensNav && window.__gtathensNav.ready() ? window.__gtathensNav.walkable(0, 0) : null })`))
  // A dying chrome from a previous run can hold 9222 just long enough to
  // accept our target and then close it ("Inspected target navigated or
  // closed") — retry the probe once on that specific failure.
  let out = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      out = await page.evaluate(PROBE)
      break
    } catch (e) {
      if (attempt === 0) { await sleep(4000); continue }
      throw e
    }
  }
  console.log('ray probe: ' + out)
  clearTimeout(watchdog)
  clearInterval(keepAlive)
  await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  killChrome()
  process.exit(0)
}

main().catch((e) => { console.error('FATAL: ' + (e && e.stack || e)); killChrome(); process.exit(1) })
