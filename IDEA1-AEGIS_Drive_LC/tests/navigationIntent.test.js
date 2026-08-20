import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLocationForIntent,
  normalizeNavigationIntent,
  readLocationIntent,
  visiblePrimaryNav,
} from '../src/lib/navigationIntent.js'

test('legacy Upload navigation opens the Files upload workflow', () => {
  assert.deepEqual(normalizeNavigationIntent('uploads'), {
    screen: 'files',
    params: { uploadOpen: true },
  })
  assert.deepEqual(normalizeNavigationIntent('files', { uploadOpen: true }), {
    screen: 'files',
    params: { uploadOpen: true },
  })
})

test('direct upload URLs normalize to Files with the drawer open', () => {
  assert.deepEqual(readLocationIntent('/upload', '', '/drive/'), {
    screen: 'files',
    params: { uploadOpen: true },
  })
  assert.deepEqual(readLocationIntent('/drive/upload', '', '/drive/'), {
    screen: 'files',
    params: { uploadOpen: true },
  })
  assert.deepEqual(readLocationIntent('/drive/files', '?upload=open', '/drive/'), {
    screen: 'files',
    params: { uploadOpen: true },
  })
})

test('file selection survives safe cross-navigation through the query string', () => {
  assert.deepEqual(readLocationIntent('/drive/shares', '?file=42', '/drive/'), {
    screen: 'shares',
    params: { fileId: '42' },
  })
  assert.equal(
    buildLocationForIntent({ screen: 'versions', params: { fileId: 'file-7' } }, '/drive/'),
    '/drive/versions?file=file-7',
  )
})

test('visible navigation removes only Upload and never expands server RBAC', () => {
  const serverNav = [
    { id: 'dashboard', group: 'navGroupWorkspace' },
    { id: 'files', group: 'navGroupWorkspace' },
    { id: 'uploads', group: 'navGroupWorkspace' },
    { id: 'shares', group: 'navGroupProtection' },
  ]
  assert.deepEqual(visiblePrimaryNav(serverNav).map((item) => item.id), [
    'dashboard', 'files', 'shares',
  ])
  assert.equal(visiblePrimaryNav(serverNav).some((item) => item.id === 'access'), false)
})
