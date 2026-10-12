import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(appRoot, file), 'utf8')
const css = read('src/interactionSystem.css')
const shares = read('src/screens/Shares.jsx')

test('Active Shares reserves six aligned tracks and reflows before they run out of room', () => {
  const columns = /--share-cols:\s*minmax\((\d+)px,\s*1fr\)\s+((?:\d+px\s*){5});/.exec(css)
  assert.ok(columns, 'one flexible File track followed by five dedicated tracks')
  const widths = [Number(columns[1]), ...columns[2].match(/\d+(?=px)/g).map(Number)]
  const gap = Number(/--share-gap:\s*(\d+)px/.exec(css)?.[1])
  const pad = Number(/--share-pad:\s*(\d+)px/.exec(css)?.[1])
  const compactAt = Number(/@container share-table \(max-width:\s*(\d+)px\)/.exec(css)?.[1])

  assert.equal(widths.length, 6)
  assert.ok(widths[1] >= 168, 'Scope has reserve beyond the previous 142px track')
  assert.ok(widths[2] >= 100, 'Auth has a separate readable track')
  assert.ok(gap >= 12, 'Scope and Auth have an explicit gap')
  assert.equal(compactAt + 1, widths.reduce((sum, width) => sum + width, 0) + 5 * gap + 2 * pad)
  assert.match(css, /\.share-table-head,\s*\.share-row\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*var\(--share-cols\);/)
  assert.match(css, /@container share-table \(max-width:\s*\d+px\)\s*\{[\s\S]*?\.share-row\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/)
})

test('Scope badge and full labels remain inside their semantic cells', () => {
  assert.match(css, /\.share-cell--scope\s*\{\s*overflow:\s*hidden;/)
  assert.match(css, /\.share-scope-badge\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*max-content;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/)
  assert.match(css, /\.share-scope-label\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/)
  assert.match(shares, /className="share-scope-badge"[^>]*title=\{scopeLabel\}/)
  for (const cell of ['scope', 'auth', 'expires', 'hits']) {
    assert.match(shares, new RegExp(`className="share-cell share-cell--${cell}"[^>]*aria-label=`), `${cell} full label`)
  }
  assert.match(shares, /className="share-revoke"[\s\S]*?disabled=\{revoking\}/)
})

test('Neo and Classic skins leave the shared row geometry unchanged in light and dark', () => {
  const classic = read('src/theme-classic.css')
  const neoLight = read('src/neoLight.css')
  const neoDark = read('src/neoDarkApp.css')
  for (const [name, sheet] of [['Classic', classic], ['Neo Light', neoLight], ['Neo Dark', neoDark]]) {
    assert.doesNotMatch(sheet, /--share-cols\s*:|\.share-(?:table|row|cell--scope|cell--auth)\s*\{[^}]*grid-template-columns\s*:/, `${name} must not override the shared tracks`)
  }
  assert.match(classic, /\.share-scope-badge\s*\{[^}]*background-image:\s*var\(--mat-plate\)/)
  assert.match(css, /:root\[data-ui-style="neo"\]\s*\{[\s\S]*?\.share-scope-badge\s*\{[^}]*background:/)
})
