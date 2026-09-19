// Live render-path probe for the KayKit GLB cars: boots the real game headless
// (CDP, same boilerplate as car-shot.mjs), clicks PLAY, then answers from the
// LIVE page:
//   1. does /models/cars/*.glb actually serve (HTTP status)?
//   2. what does GLTFLoader parse out of it (children, bbox, materials)?
//   3. are car meshes IN the scene graph near the parking spots (positions)?
//   4. renderer tris/calls + crash-module body registry (physics side).
//   node scripts/probe-carviz.mjs [url]
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const URL_ = process.argv[2] || 'http://127.0.0.1:5173/'
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
  const profile = path.join(os.tmpdir(), `carviz-${Date.now()}`)
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
    await sleep(500)
  }
  throw new Error('CDP never came up')
}
const killChrome = () => {
  try { if (chromeHandle.proc) chromeHandle.proc.kill() } catch { /* */ }
  try { if (chromeHandle.profile) rmSync(chromeHandle.profile, { recursive: true, force: true }) } catch { /* */ }
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

const main = async () => {
  const keepAlive = setInterval(() => {}, 1000)
  const watchdog = setTimeout(() => { console.error('TIMEOUT: probe-carviz > 110s'); process.exit(1) }, 110000)
  await ensureChrome()
  const { page } = await openPage()
  const excs = []
  page.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      excs.push((d.exception && d.exception.description) || d.text)
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
  let played = false
  for (let i = 0; i < 25 && !played; i += 1) {
    await sleep(1000)
    played = await page.evaluate(`(function () {
      try { return !!window.__gtathensCars && !!window.__gtathensCars.spot(0) } catch (e) { return false }
    })()`)
    // headless click can race React's event wiring — re-click a few times
    if (!played && (i === 1 || i === 4 || i === 8)) {
      await page.evaluate(`(function () {
        var b = Array.from(document.querySelectorAll('button')).find(function (x) { return /play/i.test(x.textContent) })
        if (b) b.click()
      })()`)
    }
  }
  if (!played) { console.error('game never reached PLAY with parking spots'); process.exit(1) }
  await sleep(3000)

  // 1) do the GLBs serve?
  const fetchCheck = await page.evaluate(`(async () => {
    const out = {}
    for (const f of ['sedan', 'suv', 'sports']) {
      try {
        const r = await fetch('/models/cars/' + f + '.glb')
        out[f] = r.status + ' ' + (r.headers.get('content-type') || '')
      } catch (e) { out[f] = 'ERR ' + e.message }
    }
    return JSON.stringify(out)
  })()`)
  console.log('fetch: ' + fetchCheck)

  // 2+3) parse one GLB with the page's GLTFLoader + census the live scene
  const viz = await page.evaluate(`(async () => {
    const scene = window.__gtathensScene
    const out = { scene: !!scene }
    if (scene) {
      const spots = []
      try {
        for (let i = 0; i < 26; i++) {
          const s = window.__gtathensCars && window.__gtathensCars.spot(i)
          if (s) spots.push(s)
        }
      } catch (e) { out.spotErr = String(e) }
      const meshes = []
      scene.updateWorldMatrix(true, true)
      scene.traverse((o) => {
        if (!o.isMesh) return
        const wp = o.getWorldPosition(new o.parent.position.constructor())
        let nearest = 1e9
        for (const s of spots) nearest = Math.min(nearest, Math.hypot(wp.x - s.x, wp.z - s.z))
        let vis = o
        let visible = true
        while (vis) { if (!vis.visible) { visible = false; break } vis = vis.parent }
        const pos = o.geometry && o.geometry.attributes.position
        meshes.push({
          name: o.name || '(anon)',
          x: +wp.x.toFixed(2), y: +wp.y.toFixed(2), z: +wp.z.toFixed(2),
          nearSpot: nearest < 1e8 ? +nearest.toFixed(2) : null,
          visible, verts: pos ? pos.count : 0,
          mat: o.material && o.material.type,
        })
      })
      out.totalMeshes = meshes.length
      meshes.sort((a, b) => (a.nearSpot ?? 1e9) - (b.nearSpot ?? 1e9))
      out.nearSpots = meshes.filter((m) => m.nearSpot !== null && m.nearSpot < 3.0).slice(0, 30)
      out.meshSample = meshes.slice(0, 10)
      const carLike = meshes.filter((m) => /object|car|kay|vehicle/i.test(m.name))
      out.carLikeCount = carLike.length
      out.carLikeSample = carLike.slice(0, 8)
    }
    try {
      const T = await import('/node_modules/three/build/three.module.js')
      const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js')
      const loader = new GLTFLoader()
      const gltf = await loader.loadAsync('/models/cars/sedan.glb')
      const root = gltf.scene
      const box = new T.Box3().setFromObject(root)
      const info = []
      root.traverse((o) => {
        if (o.isMesh) {
          const m = o.material
          info.push({
            name: o.name,
            verts: (o.geometry.attributes.position || {}).count,
            matType: m && m.type, color: m && m.color && m.color.getHexString(),
            transparent: m && m.transparent, opacity: m && m.opacity,
            map: !!(m && m.map), alphaTest: m && m.alphaTest,
            scale: [o.scale.x, o.scale.y, o.scale.z],
          })
        }
      })
      out.gltf = {
        children: root.children.length,
        boxMin: [box.min.x, box.min.y, box.min.z].map((n) => +n.toFixed(2)),
        boxMax: [box.max.x, box.max.y, box.max.z].map((n) => +n.toFixed(2)),
        meshes: info,
      }
    } catch (e) { out.gltfErr = String((e && e.message) || e) }
    return JSON.stringify(out)
  })()`)
  console.log('viz: ' + viz)

  // 4) renderer + physics registry
  const reg = await page.evaluate(`(async () => {
    const stats = window.__gtathensStats || {}
    let bodies = null
    try {
      const m = await import('/src/components/car-modules/crashManager.js')
      bodies = {
        reg: (m.crash.bodies || []).filter(Boolean).length,
        loose: (m.crash.loose || []).filter(Boolean).length,
        spots: (m.spotsCache.value || []).length,
        ids: (m.spotsCache.value || []).slice(0, 8).map((s) => s.id),
      }
    } catch (e) { bodies = { err: String(e) } }
    return JSON.stringify({ tris: stats.tris, calls: stats.calls, geos: stats.geos, tex: stats.tex, bodies })
  })()`)
  console.log('registry: ' + reg)
  console.log('exceptions: ' + (excs.length ? excs.slice(0, 6).join(' || ') : 'none'))

  // Phase 2: teleport in front of spot 0, dump the LIVE car mesh material +
  // NDC projection from the real camera, then screenshot from CDP.
  const live = await page.evaluate(`(async () => {
    const scene = window.__gtathensScene
    if (!scene) return 'no scene'
    const s = window.__gtathensCars.spot(0)
    if (!s) return 'no spot'
    const a = (s.rot || 0) + 0.8
    const px = s.x + Math.sin(a) * 4.5
    const pz = s.z + Math.cos(a) * 4.5
    const yaw = Math.atan2(s.x - px, s.z - pz)
    window.__gtathensTp(px, pz, yaw)
    await new Promise((r) => setTimeout(r, 2500))
    // find the car mesh nearest to the spot now
    let best = null
    let bestD = 1e9
    scene.updateWorldMatrix(true, true)
    const cam = window.__gtathensCam3 || (function findCam() {
      let c = null
      scene.traverse((o) => { if (o.isPerspectiveCamera || o.isCamera) c = o })
      return c
    })()
    scene.traverse((o) => {
      if (!o.isMesh) return
      const wp = o.getWorldPosition(new o.position.constructor())
      const d = Math.hypot(wp.x - s.x, wp.z - s.z)
      if (d < bestD) { bestD = d; best = o }
    })
    if (!best) return 'no mesh found'
    const wp = best.getWorldPosition(new best.position.constructor())
    const m = best.material
    const out = {
      spot: s,
      mesh: {
        name: best.name, x: +wp.x.toFixed(2), y: +wp.y.toFixed(2), z: +wp.z.toFixed(2),
        visibleSelf: best.visible, frustumCulled: best.frustumCulled,
        renderOrder: best.renderOrder,
        worldScale: [best.matrixWorld.elements[0], best.matrixWorld.elements[5], best.matrixWorld.elements[10]].map((n) => +n.toFixed(4)),
        bs: best.geometry.boundingSphere ? { r: +best.geometry.boundingSphere.radius.toFixed(2) } : null,
        parentChain: (() => { const c = []; let p = best; while (p) { c.push((p.type || '?') + ':' + (p.name || '') + (p.visible ? '' : '(!vis)')); p = p.parent } return c })(),
      },
      material: m ? {
        arrLen: Array.isArray(m) ? m.length : null,
        m0: (Array.isArray(m) ? m[0] : m) ? (() => {
          const q = Array.isArray(m) ? m[0] : m
          return {
            ctor: q.constructor && q.constructor.name, type: q.type,
            metalness: q.metalness, roughness: q.roughness,
            colorWrite: q.colorWrite, depthWrite: q.depthWrite, depthTest: q.depthTest,
            transparent: q.transparent, opacity: q.opacity, side: q.side, blending: q.blending,
            color: q.color && q.color.getHexString(), vertexColors: q.vertexColors,
            isMaterial: !!q.isMaterial,
            map: q.map ? { w: q.map.image && q.map.image.width, h: q.map.image && q.map.image.height, isTexture: !!q.map.isTexture } : null,
            spec: q.specularIntensity !== undefined ? q.specularIntensity : null,
            ior: q.ior !== undefined ? q.ior : null,
          }
        })() : null,
      } : null,
      geo: best.geometry ? {
        type: best.geometry.type, indexed: !!best.geometry.index,
        verts: best.geometry.attributes.position ? best.geometry.attributes.position.count : -1,
        groups: best.geometry.groups ? best.geometry.groups.map((g) => ({ start: g.start, count: g.count, mi: g.materialIndex })) : null,
        drawRange: best.geometry.drawRange ? { start: best.geometry.drawRange.start, count: best.geometry.drawRange.count } : null,
        layers: best.layers ? best.layers.mask : null,
        bb: (() => { try { best.geometry.computeBoundingBox(); const b = best.geometry.boundingBox; return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((n) => +n.toFixed(2)) } catch (e) { return String(e) } })(),
      } : null,
      cam: cam ? { px: +cam.matrixWorld.elements[12].toFixed(2), py: +cam.matrixWorld.elements[13].toFixed(2), pz: +cam.matrixWorld.elements[14].toFixed(2), fov: cam.fov, near: cam.near, far: cam.far } : null,
    }
    if (cam) {
      const p = wp.clone().project(cam)
      out.ndc = { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) }
    }
    try {
      const gl = window.__gtathensGl
      if (gl && gl.info) {
        out.glInfo = { calls: gl.info.render.calls, tris: gl.info.render.triangles, autoReset: gl.info.autoReset }
      }
    } catch (e) { out.glInfoErr = String(e) }
    return JSON.stringify(out)
  })()`)
  console.log('live: ' + live)
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(HERE, 'shot-probe-live.png'), Buffer.from(shot.data, 'base64'))
  console.log('saved shot-probe-live.png')

  // Bisect material vs geometry: borrow a KNOWN-GOOD material from another
  // scene mesh, force it (magenta) onto the car mesh in array form, disable
  // frustum culling, wait, screenshot.
  const swap = await page.evaluate(`(async () => {
    const scene = window.__gtathensScene
    const s = window.__gtathensCars.spot(0)
    if (!s) return 'no spot'
    let best = null
    let bestD = 1e9
    scene.traverse((o) => {
      if (!o.isMesh) return
      const wp = o.getWorldPosition(new o.position.constructor())
      const d = Math.hypot(wp.x - s.x, wp.z - s.z)
      if (d < bestD) { bestD = d; best = o }
    })
    if (!best) return 'no mesh'
    let donor = null
    scene.traverse((o) => {
      if (donor || !o.isMesh || o === best) return
      const mat = Array.isArray(o.material) ? o.material[0] : o.material
      if (mat && mat.isMeshStandardMaterial) donor = mat
    })
    if (!donor) return 'no donor found'
    const dm = donor.clone()
    dm.color.setRGB(1, 0, 1)
    best.material = [dm]
    best.frustumCulled = false
    await new Promise((r) => setTimeout(r, 1200))
    return 'swapped ' + best.name + ' with donor from ' + (donor.name || donor.type)
  })()`)
  console.log('swap: ' + swap)
  const shot2 = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(HERE, 'shot-probe-swap.png'), Buffer.from(shot2.data, 'base64'))
  console.log('saved shot-probe-swap.png')

  // Phase 4: body<->spot index alignment — does crash.bodies[i] sit at
  // spots[i]? (The smoke ram test reads pos(i) against spot(i); a mount-order
  // scramble would make it measure the WRONG car.)
  const align = await page.evaluate(`(async () => {
    const h = window.__gtathensCars
    if (!h) return 'no hook'
    const rows = []
    for (let i = 0; i < Math.min(10, h.count()); i++) {
      const s = h.spot(i)
      const p = h.pos(i)
      if (!s || !p) { rows.push({ i, s: !!s, p: !!p }); continue }
      rows.push({ i, id: s.id, sx: +s.x.toFixed(2), sz: +s.z.toFixed(2), bx: +p.x.toFixed(2), bz: +p.z.toFixed(2), d: +Math.hypot(p.x - s.x, p.z - s.z).toFixed(2) })
    }
    return JSON.stringify(rows)
  })()`)
  console.log('align: ' + align)

  killChrome()
  clearTimeout(watchdog)
  clearInterval(keepAlive)
  console.log('done')
  process.exit(0)
}

main().catch((e) => { console.error(e); killChrome(); process.exit(1) })

