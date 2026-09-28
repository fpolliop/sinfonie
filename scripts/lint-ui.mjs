#!/usr/bin/env node
/**
 * UI guardrails for the renderer, run with `pnpm lint:ui`:
 *  - font sizes stay on the scale (11 · 12 · 13 · 15 · 18 · 24 px); mark a deliberate miniature with data-scale-exempt
 *  - colours come from index.css tokens or lib/theme.ts, never a hex literal in a component (brand logos excepted)
 *  - no low-contrast `text-muted/NN`
 *  - no raw `err.message` rendered straight into JSX; use friendlyError / rawMessage from lib/errors
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../src/renderer/src/', import.meta.url).pathname
const SCALE = new Set(['11', '12', '13', '15', '18', '24'])
const HEX_OK = ['lib/theme.ts', 'components/colorNames.ts']

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.tsx?$/.test(name)) files.push(p)
  }
}
walk(ROOT)

const problems = []
for (const file of files) {
  const rel = relative(ROOT, file)
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const at = `${rel}:${i + 1}`
      for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (!SCALE.has(m[1]) && !line.includes('data-scale-exempt')) problems.push(`${at}  font size ${m[1]}px is off the scale (11 12 13 15 18 24)`)
      }
      if (!HEX_OK.includes(rel) && !/<path fill=/.test(line)) {
        for (const m of line.matchAll(/['"`(]#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) if (!/^(fff|ffffff|000|000000)$/i.test(m[1])) problems.push(`${at}  hex colour #${m[1]}; use a token (index.css) or lib/theme.ts`)
      }
      if (/text-muted\/\d+/.test(line)) problems.push(`${at}  text-muted/NN fails contrast; use text-muted`)
      if (/\{\s*(err|error)\.message\s*\}/.test(line)) problems.push(`${at}  raw error message in JSX; use friendlyError()`)
    })
}

if (problems.length) {
  console.error(problems.join('\n'))
  console.error(`\n${problems.length} UI lint problem(s).`)
  process.exit(1)
}
console.log(`UI lint: ${files.length} files clean.`)
