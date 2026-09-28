// scripts/install-kenney-roads.mjs — install the Kenney "City Kit (Roads)"
// props into public/models/kenney/roads/ and fix up the atlas layout.
//
// WHY THIS EXISTS
// ---------------
// Kenney's GLBs reference their shared colour atlas by the RELATIVE uri
// `Textures/colormap.png`. three's GLTFLoader resolves that against the .glb's
// own URL, so the atlas must exist at
//
//     <dir of the .glb>/Textures/colormap.png
//
// Copying the pack's GLBs and its colormap.png into ONE flat folder (which is
// what the building packs look like) therefore fails at load time with
//
//     THREE.GLTFLoader: Couldn't load texture Textures/colormap.png
//
// and every prop renders UNTEXTURED/white — or the loader throws and takes the
// scene with it. This script creates the `Textures/` subfolder the loader
// actually asks for, so the fix lives in one place instead of in a path string
// buried in a component.
//
// The pack is CC0 (https://creativecommons.org/publicdomain/zero/1.0/), so the
// files are committed rather than downloaded at build time. Re-running this
// script after dropping new .glb files into the folder re-applies the layout.
//
// Usage: node scripts/install-kenney-roads.mjs
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.join(process.cwd(), 'public', 'models', 'kenney', 'roads')
const TEX = path.join(DIR, 'Textures')

if (!fs.existsSync(DIR)) {
  console.error(`missing ${DIR} - add the Kenney road .glb files first`)
  process.exit(1)
}

fs.mkdirSync(TEX, { recursive: true })

// The pack's own layout keeps the atlas in `Models/GLB format/Textures/`, so
// the source may be either the flat colormap.png or a pre-made Textures copy.
const srcFlat = path.join(DIR, 'colormap.png')
const srcTex = path.join(TEX, 'colormap.png')
if (!fs.existsSync(srcTex)) {
  if (fs.existsSync(srcFlat)) fs.copyFileSync(srcFlat, srcTex)
  else {
    console.error('no colormap.png found in the roads folder')
    process.exit(1)
  }
}

const glbs = fs.readdirSync(DIR).filter((f) => f.endsWith('.glb'))
const bytes = glbs.reduce((n, f) => n + fs.statSync(path.join(DIR, f)).size, 0)
console.log(`kenney roads: ${glbs.length} glb (${(bytes / 1024).toFixed(0)} KB) + Textures/colormap.png`)
