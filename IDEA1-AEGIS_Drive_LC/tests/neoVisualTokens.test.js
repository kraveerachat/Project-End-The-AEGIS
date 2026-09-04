import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/index.css'), 'utf8')
const settingsSource = fs.readFileSync(path.resolve(import.meta.dirname, '../src/screens/Settings.jsx'), 'utf8')

test('Neo mobile segmented options meet the 44 by 44 CSS touch-target floor', () => {
  const start = css.lastIndexOf('@media (max-width: 767px)')
  const end = css.indexOf('@media (prefers-reduced-motion: reduce)', start)
  const mobile = css.slice(start, end)
  assert.match(mobile, /\.ui-segmented-option[\s\S]*min-height:\s*44px/)
  assert.match(mobile, /\.ui-segmented-option[\s\S]*min-width:\s*44px/)
})

test('Neo defines intentional warning contrast and reduced-motion behavior', () => {
  assert.match(css, /:root\[data-ui-style="neo"\][\s\S]*--warn:\s*#945600/)
  assert.match(settingsSource, /settings-section-button/)
  assert.match(settingsSource, /is-active bg-ink text-card/)
  assert.match(css, /\.settings-section-button\.is-active[\s\S]*var\(--neo-selection\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.interface-style-preview[\s\S]*transform:\s*none !important/)
})
