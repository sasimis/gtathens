// Headless smoke test for the dev server: launches Chrome itself, boots the app,
// captures uncaught exceptions / console errors with stack traces, clicks PLAY,
// then probes live DOM + Rapier state.
//
//   cd workspace && node scripts/smoke.mjs [url] [bootSeconds] [playSeconds]
//
// No dependencies: uses Node's global fetch + WebSocket (Node >= 22) and
// spawns Chrome/Edge with a throwaway profile on its own debug port.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Mirror every log line to a file as well: stdout through a pipe can be
// buffered/dropped depending on how the script is launched, which made this
// script look like it produced nothing at all.
const REPORT = fileURLToPath(new URL('./smoke-report.txt', import.meta.url))
writeFileSync(REPORT, '')
const mirror = (orig) => (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  orig(line)
  try { appendFileSync(REPORT, line + '\r\n') } catch (e) { /* ignore */ }
}
console.log = mirror(console.log.bind(console))
console.error = mirror(console.error.bind(console))
const PORT = 9222
const TARGET_URL = process.argv[2] || 'http://127.0.0.1:5173/'
const BOOT_SECONDS = Number(process.argv[3] || 12)
const POST_SECONDS = Number(process.argv[4] || 8)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cdpFetch = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init)
  return res.json()
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.handlers = []
    // Node's WebSocket throws "Sent before connected." when send() races the
    // handshake, so every send() waits for the socket to be open first.
    this.ready = new Promise((resolve, reject) => {
      if (ws.readyState === 1) resolve()
      else {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', () => reject(new Error('websocket failed to open')))
      }
    })
    ws.addEventListener('error', (ev) => {
      console.error('websocket error: ' + (ev.message || ev.type || 'unknown'))
    })
    ws.addEventListener('close', (ev) => {
      console.error('websocket closed: code=' + ev.code + ' reason=' + (ev.reason || ''))
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
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

// Chrome we launched ourselves (null proc when we attached to an existing one),
// so both the success and the error path can kill it + delete its profile.
let chromeHandle = { proc: null, profile: null }

/** Make sure something answers CDP on PORT. Launches Chrome/Edge ourselves if
 * not, so the script is a single command (a hand-started chrome does not
 * survive the shell that spawned it). */
const ensureChrome = async () => {
  if (await devtoolsUp()) return chromeHandle
  const exe = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!exe) throw new Error('no Chrome/Edge found — set CHROME_PATH')
  const profile = path.join(os.tmpdir(), `gta-smoke-${Date.now()}`)
  const proc = spawn(
    exe,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--enable-unsafe-swiftshader',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  chromeHandle = { proc, profile }
  for (let i = 0; i < 60; i += 1) {
    if (await devtoolsUp()) return chromeHandle
    await sleep(250)
  }
  throw new Error(`chrome never exposed devtools on ${PORT}`)
}

/** Kill the chrome we launched (leave an externally-started one alone) and
 * delete its throwaway profile. */
const killChrome = () => {
  const { proc, profile } = chromeHandle
  if (proc) { try { proc.kill() } catch (e) { /* ignore */ } }
  if (profile) { try { rmSync(profile, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
  chromeHandle = { proc: null, profile: null }
}

const openPage = async () => {
  const version = await cdpFetch('/json/version')
  const browser = new Cdp(new WebSocket(version.webSocketDebuggerUrl))
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  let pageWs = null
  for (let i = 0; i < 40 && !pageWs; i += 1) {
    const list = await cdpFetch('/json/list')
    pageWs = list.find((t) => t.id === targetId)?.webSocketDebuggerUrl || null
    if (!pageWs) await sleep(100)
  }
  if (!pageWs) throw new Error('could not find page target websocket')
  return { browser, page: new Cdp(new WebSocket(pageWs)), targetId }
}

const PROBE = `JSON.stringify({
  rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
  rootHtmlLen: document.getElementById('root') ? document.getElementById('root').innerHTML.length : -1,
  canvas: !!document.querySelector('canvas'),
  viteOverlay: !!document.querySelector('vite-error-overlay'),
  hasStats: !!window.__gtathensStats,
  hasPhysics: !!window.__gtathensPhysics,
  bodies: window.__gtathensPhysics && window.__gtathensPhysics.world && window.__gtathensPhysics.world.bodies ? window.__gtathensPhysics.world.bodies.len() : null,
  colliders: window.__gtathensPhysics && window.__gtathensPhysics.world && window.__gtathensPhysics.world.colliders ? window.__gtathensPhysics.world.colliders.len() : null,
  debugButtons: !!window.__gtathensDebug,
  stats: window.__gtathensStats || null,
  buttons: Array.from(document.querySelectorAll('button')).map(function(b){ return b.textContent.trim() }).slice(0, 12),
  text: (document.getElementById('root') ? document.getElementById('root').innerText : '').replace(/\\s+/g, ' ').slice(0, 200)
})`

const main = async () => {
  // Node's built-in WebSocket does not always hold the event loop open, which
  // made this script exit(0) silently mid-handshake. Keep the loop alive and
  // hard-fail rather than hanging forever.
  const keepAlive = setInterval(() => {}, 1000)
  const watchdog = setTimeout(() => {
    console.error('TIMEOUT: smoke test exceeded 120s')
    process.exit(1)
  }, 120000)
  await ensureChrome()
  const { browser, page, targetId } = await openPage()
  const exceptions = new Map()
  const consoleErrors = []

  page.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      const key = (d.exception && d.exception.description) || d.text
      if (!exceptions.has(key)) {
        const frames = (d.stackTrace && d.stackTrace.callFrames ? d.stackTrace.callFrames : [])
          .slice(0, 8)
          .map((f) => `${f.functionName || '<anon>'} @ ${f.url.split('/').pop()}:${f.lineNumber}`)
        exceptions.set(key, { count: 0, frames })
      }
      exceptions.get(key).count += 1
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      consoleErrors.push(`${msg.params.type}: ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200))
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(`log: ${msg.params.entry.text.slice(0, 200)}`)
    }
  })

  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('Page.enable')
  await page.send('Page.navigate', { url: TARGET_URL })

  console.log(`booting ${TARGET_URL} for ${BOOT_SECONDS}s ...`)
  await sleep(BOOT_SECONDS * 1000)

  console.log('\n--- state after boot ---')
  console.log(await page.evaluate(PROBE))

  console.log('\n--- clicking PLAY ---')
  console.log(await page.evaluate(`(function(){
    var b = Array.from(document.querySelectorAll('button')).find(function(x){ return /play|start|enter/i.test(x.textContent) });
    if (!b) return 'no play button found';
    b.click();
    return 'clicked: ' + b.textContent.trim();
  })()`))

  await sleep(POST_SECONDS * 1000)
  console.log(`\n--- state after PLAY (${POST_SECONDS}s) ---`)
  console.log(await page.evaluate(PROBE))

  // --- W / S direction test (real CDP key events -> drei listeners) ---
  const tap = async (code, key, vk) => {
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    })
    await sleep(700)
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    })
    await sleep(600)
  }
  // Angle of the move segment vs the camera-forward unit vector.
  const seg = (a, b, camYaw) => {
    const mx = b.x - a.x
    const mz = b.z - a.z
    const len = Math.hypot(mx, mz)
    if (len < 0.04) return 'NO-MOVE (' + len.toFixed(3) + 'm)'
    const fx = Math.sin(camYaw)
    const fz = Math.cos(camYaw)
    const ang = (Math.acos(Math.max(-1, Math.min(1, (mx * fx + mz * fz) / len))) * 180) / Math.PI
    return len.toFixed(2) + 'm @ ' + ang.toFixed(0) + 'deg from camera-forward'
  }
  console.log('\n--- W/S direction test ---')
  const P = async () => JSON.parse(await page.evaluate('JSON.stringify(window.__gtathensPlayer)'))
  const C = async () => JSON.parse(await page.evaluate('JSON.stringify(window.__gtathensCam)'))
  const p0 = await P(); const c0 = await C()
  await sleep(1500) // let the model finish loading / trace start moving
  const p0b = await P()
  await tap('KeyW', 'w', 87)
  const pW = await P(); const cW = await C()
  console.log('W moved: ' + seg(p0b, pW, c0.yaw))
  await tap('KeyS', 's', 83)
  const pS = await P()
  console.log('S moved: ' + seg(pW, pS, cW.yaw))
  const camDrift = Math.abs(cW.yaw - c0.yaw) * (180 / Math.PI)
  console.log('camera yaw drift during W/S: ' + camDrift.toFixed(2) + 'deg (must be ~0, no 180 flip)')

  // --- D strafe test: must move along camera-RIGHT (forward x up) ---
  await tap('KeyD', 'd', 68)
  const pD = await P()
  {
    const mx = pD.x - pS.x
    const mz = pD.z - pS.z
    const len = Math.hypot(mx, mz)
    // Camera-right unit vector = forward x up = (-cos yaw, sin yaw)
    const rx = -Math.cos(cW.yaw)
    const rz = Math.sin(cW.yaw)
    const dot = len < 0.04 ? 0 : Math.max(-1, Math.min(1, (mx * rx + mz * rz) / len))
    const ang = len < 0.04 ? -1 : (Math.acos(dot) * 180) / Math.PI
    console.log('D strafed: ' + (len < 0.04 ? 'NO-MOVE' : len.toFixed(2) + 'm @ ' + ang.toFixed(0) + 'deg from camera-right (expect ~0)'))
  }

  // --- Car enter/exit via the REAL F key (exercises the unmount crash path) ---
  console.log('\n--- car enter/exit test (F key, real path) ---')
  console.log('car hook: ' + await page.evaluate('window.__gtathensCar ? "yes (" + window.__gtathensCar.count + " spots)" : "MISSING"'))
  console.log('tp to car 0 -> ' + await page.evaluate('window.__gtathensCar ? String(window.__gtathensCar.tp(0)) : "no hook"'))
  await sleep(500)
  console.log('near car index: ' + await page.evaluate('window.__gtathensCar ? String(window.__gtathensCar.near()) : "no hook"'))
  console.log('trace after tp: ' + await page.evaluate('JSON.stringify({ x: +window.__gtathensPlayer.x.toFixed(2), z: +window.__gtathensPlayer.z.toFixed(2) })'))
  const flog = () => page.evaluate('JSON.stringify({ f: window.__gtathensF || [], st: (window.__gtathensCar && window.__gtathensCar.state) ? window.__gtathensCar.state() : null })')
  await tap('KeyF', 'f', 70)
  await sleep(1500)
  console.log('after F#1 (enter tap): ' + await flog())
  console.log('after F (enter): ' + await page.evaluate(
    'JSON.stringify({ carHookGone: !window.__gtathensCar, physicsAlive: !!window.__gtathensPhysics, bodies: window.__gtathensPhysics ? window.__gtathensPhysics.world.bodies.len() : null, canvas: !!document.querySelector("canvas") })'))
  await tap('KeyF', 'f', 70)
  await sleep(1500)
  console.log('after F#2 (exit tap): ' + await flog())
  console.log('after F (exit):  ' + await page.evaluate(
    'JSON.stringify({ carHookBack: !!window.__gtathensCar, physicsAlive: !!window.__gtathensPhysics, canvas: !!document.querySelector("canvas") })'))

  // --- re-enter the just-exited car WITHOUT moving (live-position detect) ---
  await sleep(400)
  console.log('near after exit (re-enter detect): ' + await page.evaluate('window.__gtathensCar ? String(window.__gtathensCar.near()) : "no hook"'))
  console.log('post-exit player vs spot0: ' + await page.evaluate('(function(){ var p = window.__gtathensPlayer; var h = window.__gtathensCar; if (!h || !h.spot) return "no hook"; var s0 = h.spot(0); if (!s0 || !p) return "no data"; var d = Math.hypot(p.x - s0.x, p.z - s0.z); return JSON.stringify({ px: +p.x.toFixed(2), pz: +p.z.toFixed(2), s0x: +s0.x.toFixed(2), s0z: +s0.z.toFixed(2), dist: +d.toFixed(2), near: h.near() }); })()'))
  await tap('KeyF', 'f', 70)
  await sleep(1500)
  console.log('after F (re-enter): ' + await page.evaluate(
    'JSON.stringify({ carHookGone: !window.__gtathensCar, physicsAlive: !!window.__gtathensPhysics, canvas: !!document.querySelector("canvas") })'))

  // --- car-vs-car crash test: ram a parked car at speed (real physics) ---
  // Still driving car 0 here (the re-enter F tap above). Pick a target spot
  // comfortably away from our own position, teleport 6.5 m behind it, floor
  // it with a REAL W key, then measure how far the victim moved + its damage.
  console.log('\n--- car-vs-car crash test (ram) ---')
  console.log('cars hook: ' + await page.evaluate('window.__gtathensCars ? "yes (" + window.__gtathensCars.count() + " spots)" : "MISSING"'))
  // Diagnostic (read-only): cross-check the parked-car registry against the
  // real Rapier world. `hist` is a histogram of every body type in the world,
  // `notFixed` lists parked cars whose body is NOT fixed (the driven one is
  // dynamic on purpose), and `unregistered` lists slots with no body handle.
  // This is the probe that catches "cars are secretly dynamic -> the crash
  // gate never fires" bug classes. Uses the QA hook (the REAL module instance —
  // a fresh import() of the module would create a second instance under Vite
  // HMR and report empty arrays).
  const carDiag = (label) => page.evaluate(`(function(){
    var h = window.__gtathensCars
    if (!h) return 'no hook'
    var TYPE = { 0: 'dynamic', 1: 'fixed', 2: 'kinPos', 3: 'kinVel' }
    var hist = {}
    var world = window.__gtathensPhysics && window.__gtathensPhysics.world
    var inWorld = 0
    if (world && world.bodies && world.bodies.forEach) world.bodies.forEach(function (b) {
      inWorld++
      var k = TYPE[b.bodyType()] || String(b.bodyType())
      hist[k] = (hist[k] || 0) + 1
    })
    var n = h.count(), notFixed = [], unregistered = []
    for (var i = 0; i < n; i++) {
      var t = h.btype ? h.btype(i) : null
      if (t === null) { unregistered.push(i); continue }
      if (t !== 1) notFixed.push(i + ':' + (TYPE[t] || t))
    }
    // Surface probe: the asphalt cache must be published by Roads.jsx and a
    // parked car must sit ON asphalt (else every car drives at 0.55x speed).
    var roadSegs = h.roadSegs ? h.roadSegs() : -1
    var s0 = h.spot(0), s1 = h.spot(1)
    var asphalt = {
      segs: roadSegs,
      atSpot0: s0 && h.asphalt ? h.asphalt(s0.x, s0.z) : null,
      atSpot1: s1 && h.asphalt ? h.asphalt(s1.x, s1.z) : null,
      farAway: h.asphalt && s0 ? h.asphalt(s0.x + 260, s0.z + 260) : null,
    }
    return JSON.stringify({ label: '${label}', spots: n, loose: h.loose(), worldBodies: inWorld, hist: hist, notFixed: notFixed, unregistered: unregistered, asphalt: asphalt })
  })()`)
  console.log('car registry diag ' + (await carDiag('pre-ram')))
  const ramTarget = await page.evaluate('(function(){ var h = window.__gtathensCars; if (!h) return 1; var me = h.pos(0); if (!me) return 1; var best = null; for (var i = 1; i < h.count(); i++) { var p = h.spot(i); if (!p) continue; var d = Math.hypot(p.x - me.x, p.z - me.z); if (d > 12 && (!best || d < best.d)) best = { i: i, d: d }; } return best ? best.i : 1; })()')
  console.log('ram target spot ' + ramTarget + ' -> ' + await page.evaluate('window.__gtathensCars ? JSON.stringify(window.__gtathensCars.ram(' + ramTarget + ')) : "no hook"'))
  await sleep(500)
  const prePos = JSON.parse(await page.evaluate('JSON.stringify(window.__gtathensCars ? window.__gtathensCars.pos(' + ramTarget + ') : null)'))
  console.log('pre-hit target: ' + JSON.stringify(prePos) + ' dmg=' + (await page.evaluate('window.__gtathensCars.damage(' + ramTarget + ')')) + ' :: ' + (await carDiag('post-ram')))
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 })
  await sleep(1900)
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 })
  await sleep(2600) // let the shoved car slide + re-freeze
  const postPos = JSON.parse(await page.evaluate('JSON.stringify(window.__gtathensCars ? window.__gtathensCars.pos(' + ramTarget + ') : null)'))
  const postDmg = await page.evaluate('window.__gtathensCars ? window.__gtathensCars.damage(' + ramTarget + ') : -1')
  const stillLoose = await page.evaluate('window.__gtathensCars ? window.__gtathensCars.loose() : -1')
  const crashMoved = prePos && postPos ? Math.hypot(postPos.x - prePos.x, postPos.z - prePos.z) : -1
  console.log('post-hit: target moved ' + crashMoved.toFixed(2) + 'm, damage=' + (+postDmg).toFixed(3) + ', looseNow=' + stillLoose)
  console.log('car registry diag ' + (await carDiag('post-drive')))
  console.log((crashMoved > 0.25 && postDmg > 0.01) ? 'CRASH TEST: PASS' : 'CRASH TEST: FAIL')

  // --- shooting test: real X key -> WeaponController -> ped damage ---------
  // Still driving after the crash test, so climb out first (real F key).
  console.log('\n--- shooting test (guns / peds / drops) ---')
  await tap('KeyF', 'f', 70)
  await sleep(1400)
  console.log('on foot again: ' + await page.evaluate(
    'JSON.stringify({ player: !!window.__gtathensPlayer, tp: !!window.__gtathensTp, npcs: !!window.__gtathensNpcs, pickups: !!window.__gtathensPickups })'))
  console.log('peds: ' + await page.evaluate('window.__gtathensNpcs ? window.__gtathensNpcs.count() + " (alive " + window.__gtathensNpcs.aliveCount() + ")" : "MISSING"'))
  const give = await page.evaluate('window.__gtathensGive ? window.__gtathensGive("smg", 90) : { error: "MISSING" }')
  console.log('give smg: ' + JSON.stringify(give))
  await sleep(400)
  // Stand 1.6 m from the nearest ped, FACING it: tpTo also sets camYaw, so the
  // chase camera (and the aim ray) points at the target.
  const shot = await page.evaluate(`(function(){
    var h = window.__gtathensNpcs; var tp = window.__gtathensTp; var p = window.__gtathensPlayer;
    if (!h || !tp || !p) return { error: 'missing hooks' };
    var i = h.nearest(p.x, p.z);
    if (i < 0) return { error: 'no living ped' };
    var t = h.ped(i);
    var dx = t.x - p.x, dz = t.z - p.z;
    var len = Math.hypot(dx, dz) || 1;
    var fx = dx / len, fz = dz / len;
    var sx = t.x - fx * 1.5, sz = t.z - fz * 1.5;
    tp(sx, sz, Math.atan2(fx, fz));
    return { i: i, hp: t.hp, dist: +len.toFixed(2), x: +t.x.toFixed(2), z: +t.z.toFixed(2) };
  })()`)
  console.log('target ped: ' + JSON.stringify(shot))
  await sleep(900) // let the chase camera swing to the new yaw
  const moneyBefore = await page.evaluate('window.__gtathensStore ? window.__gtathensStore.money : -1')
  const dropsBefore = await page.evaluate('window.__gtathensPickups ? window.__gtathensPickups.drops() : -1')
  // Peds WALK (~1.5 m/s), so a single long burst misses: hold the REAL X key
  // while a page-side loop re-aims at the ped's LIVE position every 80 ms
  // (tpTo also sets camYaw). That keeps the chase camera — and therefore the
  // aim ray — on the target for the whole burst.
  const target = shot && shot.i >= 0 ? shot.i : -1
  await page.evaluate(`(function(){
    if (window.__aimLoop) clearInterval(window.__aimLoop);
    if (window.__shotSampler) clearInterval(window.__shotSampler);
    // Trails (QA diagnosis): the aim loop records the ped's live position per
    // tick; a parallel 100 ms sampler records the per-shot telemetry + camera.
    // Post-burst we correlate each impact with the ped position at the nearest
    // tick to answer "did the ray miss the capsule, and by how much".
    window.__aimTrail = []
    window.__shotTrail = []
    window.__aimLoop = setInterval(function(){
      var h = window.__gtathensNpcs, tp = window.__gtathensTp, p = window.__gtathensPlayer;
      if (!h || !tp || !p) return;
      var t = h.ped(${target});
      if (!t || t.dead) return;
      window.__aimTrail.push({ at: Date.now(), x: t.x, z: t.z });
      if (window.__aimTrail.length > 600) window.__aimTrail.shift();
      var dx = t.x - p.x, dz = t.z - p.z;
      var len = Math.hypot(dx, dz) || 1;
      var fx = dx / len, fz = dz / len;
      tp(t.x - fx * 1.25, t.z - fz * 1.25, Math.atan2(fx, fz));
    }, 80);
    window.__shotSampler = setInterval(function(){
      var s = window.__gtathensShot, c = window.__gtathensCam;
      if (!s || !s.shots) return;
      window.__shotTrail.push({ at: Date.now(), n: s.shots, ix: s.x, iy: s.y, iz: s.z, toi: s.toi, px: s.px, pz: s.pz, camX: c && c.x, camY: c && c.y, camZ: c && c.z, camYaw: c && c.yaw });
      if (window.__shotTrail.length > 600) window.__shotTrail.shift();
    }, 100);
    return true;
  })()`)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 })
  await sleep(2600)
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 })
  await page.evaluate('if (window.__aimLoop) { clearInterval(window.__aimLoop); window.__aimLoop = null } if (window.__shotSampler) { clearInterval(window.__shotSampler); window.__shotSampler = null } true')
  // Correlate: for every sampled shot, the ped position at the nearest aim
  // tick, and the angular error of the camera-forward vs the player->ped line.
  const miss = await page.evaluate(`(function(){
    var aim = window.__aimTrail || [], shots = window.__shotTrail || [];
    var out = [];
    for (var i = 0; i < shots.length; i++) {
      var s = shots[i], best = null, bd = 1e18;
      for (var j = 0; j < aim.length; j++) {
        var d = Math.abs(aim[j].at - s.at);
        if (d < bd) { bd = d; best = aim[j] }
      }
      if (!best || bd > 120) continue;
      var dist = Math.hypot(s.ix - best.x, s.iz - best.z);
      var toPed = Math.atan2(best.x - s.px, best.z - s.pz);
      var aimYaw = Math.atan2(s.ix - s.px, s.iz - s.pz);
      var err = Math.abs(((aimYaw - toPed + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      out.push({ n: s.n, dist: +dist.toFixed(2), errDeg: +(err * 180 / Math.PI).toFixed(1), toi: +s.toi.toFixed(2), lagMs: bd });
    }
    return out;
  })()`)
  if (miss.length) {
    const dists = miss.map((m) => m.dist)
    const errs = miss.map((m) => m.errDeg)
    console.log('impact->ped per shot: min ' + Math.min(...dists).toFixed(2) + ' m, median ' + dists.sort((a, b) => a - b)[Math.floor(dists.length / 2)].toFixed(2) + ' m, max ' + Math.max(...dists).toFixed(2) + ' m (hit needs the ray to stop on the capsule, < ~0.35 m lateral)')
    console.log('aim error per shot:   min ' + Math.min(...errs).toFixed(1) + ' deg, median ' + errs.slice().sort((a, b) => a - b)[Math.floor(errs.length / 2)].toFixed(1) + ' deg, max ' + Math.max(...errs).toFixed(1) + ' deg')
    console.log('shot count sampled: ' + miss.length + ' (n ' + miss[0].n + '..' + miss[miss.length - 1].n + '), last: ' + JSON.stringify(miss[miss.length - 1]))
  } else {
    console.log('impact->ped per shot: NO SAMPLES (sampler/aim trail empty)')
  }
  await sleep(1200)
  const shotInfo = await page.evaluate('JSON.stringify(window.__gtathensShot || null)')
  console.log('shot telemetry: ' + shotInfo)
  console.log('muzzle chain: ' + await page.evaluate('window.__gtathensMuzzle ? JSON.stringify(window.__gtathensMuzzle()) : "no hook"'))
  console.log('cam: ' + await page.evaluate('JSON.stringify(window.__gtathensCam || null)'))
  const after = await page.evaluate('window.__gtathensNpcs && ' + target + ' >= 0 ? JSON.stringify(window.__gtathensNpcs.ped(' + target + ')) : "no target"')
  const storeSnap = await page.evaluate('JSON.stringify(window.__gtathensStore || null)')
  const dropsAfter = await page.evaluate('window.__gtathensPickups ? window.__gtathensPickups.drops() : -1')
  const moneyAfter = await page.evaluate('window.__gtathensStore ? window.__gtathensStore.money : -1')
  const killed = /"dead":true/.test(after)
  console.log('ped after burst: ' + after)
  console.log('store: ' + storeSnap + ' (money ' + moneyBefore + ' -> ' + moneyAfter + ')')
  console.log('loot drops: ' + dropsBefore + ' -> ' + dropsAfter)
  const damaged = (() => {
    try {
      const p = JSON.parse(after)
      return typeof p.hp === 'number' && p.hp < shot.hp
    } catch (e) { return false }
  })()
  console.log((damaged || killed) ? 'SHOOT TEST: PASS' : 'SHOOT TEST: FAIL')

  console.log('\n--- uncaught exceptions (deduped) ---')
  if (exceptions.size === 0) console.log('none')
  for (const [msg, info] of exceptions) {
    console.log(`x${info.count}  ${msg.split('\n')[0]}`)
    for (const f of info.frames) console.log(`        ${f}`)
  }

  console.log('\n--- console errors/warnings ---')
  const uniq = [...new Set(consoleErrors)]
  if (uniq.length === 0) console.log('none')
  for (const e of uniq.slice(0, 25)) console.log(`  ${e}`)

  await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  clearInterval(keepAlive)
  clearTimeout(watchdog)
  await finish(browser, page)
}

// NOTE: never use process.exit() here — Node drops buffered stdout when it is
// redirected to a pipe/file, which silently swallowed this script's output.
async function finish(browser, page) {
  try { page.ws.close() } catch (e) { /* ignore */ }
  try { browser.ws.close() } catch (e) { /* ignore */ }
  killChrome()
  await sleep(200)
  process.exitCode = 0
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message)
  killChrome()
  process.exitCode = 1
})
