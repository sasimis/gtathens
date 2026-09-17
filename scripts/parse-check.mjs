// Parse-check every source file with the exact Babel parser/plugin set that
// @vitejs/plugin-react uses in the browser (dev) transform. Use this to tell a
// REAL syntax error apart from a stale IDE/TypeScript-server diagnostic.
//
//   cd workspace && node scripts/parse-check.mjs
//
// Exit code 0 = every file parses. Non-zero = at least one file is broken.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'

const srcDir = fileURLToPath(new URL('../src', import.meta.url))

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (['.js', '.jsx', '.mjs'].includes(extname(p))) files.push(p)
  }
}
walk(srcDir)

let bad = 0
for (const f of files) {
  const code = readFileSync(f, 'utf8')
  try {
    parse(code, { sourceType: 'module', plugins: ['jsx'], errorRecovery: false })
  } catch (err) {
    bad += 1
    const rel = f.slice(srcDir.length + 1)
    console.log(`FAIL src/${rel} -> ${err.message}`)
    if (err.loc) console.log(`     line ${err.loc.line} col ${err.loc.column}`)
  }
}

if (bad === 0) console.log(`OK: all ${files.length} files parse clean`)
else console.log(`${bad}/${files.length} files FAILED`)
process.exit(bad === 0 ? 0 : 1)