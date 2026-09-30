import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const protectedPaths = [
  'HUB-AEGIS_Entry/src/App.jsx',
  'HUB-AEGIS_Entry/src/screens/Hub.jsx',
  'IDEA1-AEGIS_Drive_LC/src/App.jsx',
  'IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx',
  'IDEA1-AEGIS_Drive_LC/src/lib/theme.js',
  'IDEA1-AEGIS_Drive_LC/src/lib/strings.js',
  'IDEA1-AEGIS_Drive_LC/src/index.css',
  'IDEA2-AEGIS_Monitor/src/App.jsx',
  'IDEA2-AEGIS_Monitor/src/screens/Login.jsx',
]
const executableTests = [
  'HUB-AEGIS_Entry/tests/backNavigation.test.mjs',
  'HUB-AEGIS_Entry/tests/coreEntryR4.browser.test.mjs',
  'IDEA1-AEGIS_Drive_LC/tests/authBackBoundaryR4.test.js',
  'IDEA1-AEGIS_Drive_LC/tests/shellThemeR4.test.js',
  'IDEA1-AEGIS_Drive_LC/tests/loginExperienceR3.test.js',
  'IDEA1-AEGIS_Drive_LC/tests/themeAuthTransition.test.js',
  'IDEA2-AEGIS_Monitor/tests/shellThemeR4.test.mjs',
]

test('R4 protected source boundaries carry a Human-owner warning', () => {
  for (const path of protectedPaths) {
    const source = readFileSync(resolve(root, path), 'utf8')
    assert.match(source, /AEGIS CORE ENTRY UX CONTRACT — HUMAN OWNER CONTROLLED/, path)
  }
})

test('R4 AGENTS contract names real executable guards', () => {
  const agents = readFileSync(resolve(root, 'AGENTS.md'), 'utf8')
  assert.match(agents, /## Protected Core Entry UX Contract/)
  for (const path of executableTests) {
    assert.ok(existsSync(resolve(root, path)), `missing executable guard ${path}`)
    assert.ok(agents.includes(path), `AGENTS.md must name ${path}`)
  }
})
