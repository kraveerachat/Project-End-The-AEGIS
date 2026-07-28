import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('Monitor presentation contract uses a feed-first two-column Live canvas', () => {
  assert.match(css, /\/\* IDEA2 CCTV presentation redesign v1 \*\//)
  assert.match(css, /\.canvas\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(286px,\s*340px\)/s)
  assert.match(css, /\.canvasR\s*\{[^}]*width:\s*auto[^}]*min-width:\s*0/s)
})

test('Live canvas collapses structurally on narrow screens without hiding real feeds', () => {
  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.canvas\s*\{[^}]*grid-template-columns:\s*1fr/s)
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.secondrow\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)/s)
})

test('Presentation motion has a reduced-motion fallback', () => {
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.scanline[\s\S]*?animation:\s*none\s*!important/s)
})
