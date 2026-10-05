// tests/bulkZipPanelStrings.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 10a/10b
//
// Strings: every new ZIP key exists in en/th/zh, non-empty, in the right script.
// Panel (M-4): explicit stages for the archive —
//   preparing  label shown, Cancel available, rate row reserved
//   archiving  "File i of N: name", measured (rate row), Cancel available
//   finalizing label shown, no rate row, NO Cancel (close() may already be committing, spec §17/§20)
//   reasons    localDiskFull / finalizeFailed use the new local-disk keys, never the Data Lake noSpace key
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')
let vite
let VaultTransferPanel

before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, esbuild: { jsx: 'automatic' },
  })
  ;({ VaultTransferPanel } = await vite.ssrLoadModule('/src/components/vault/VaultTransferPanel.jsx'))
})
after(async () => { await vite?.close() })

const NEW_KEYS = [
  'zipPreparing', 'zipArchiving', 'zipFinalizing', 'zipFailedEntry', 'zipFoldersSkipped', 'zipUnavailable', 'zipTooManyFiles',
  'zipV1NotSupported', 'vaultZipExportTitle', 'vaultZipExportBody', 'vaultZipExportConfirm',
  'xferReasonLocalDiskFull', 'xferReasonFinalizeFailed', 'filesDownloadBusy', 'filesZipLargeFallback',
]

test('ZSTR-1 every new key exists in en/th/zh, non-empty, with the right script and placeholders', () => {
  for (const lang of LANGS) {
    for (const key of NEW_KEYS) {
      const v = STRINGS[lang][key]
      assert.equal(typeof v, 'string', `${lang}.${key}`)
      assert.ok(v.trim(), `${lang}.${key} non-empty`)
    }
  }
  for (const key of NEW_KEYS) {
    assert.ok(!/[ก-๙一-龥]/u.test(STRINGS.en[key]), `en.${key}`)
    assert.ok(/[ก-๙]/u.test(STRINGS.th[key]), `th.${key} is Thai`)
    assert.ok(/[一-龥]/u.test(STRINGS.zh[key]), `zh.${key} is Chinese`)
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const lang of ['th', 'zh']) assert.deepEqual(vars(STRINGS[lang][key]), vars(STRINGS.en[key]), `${lang}.${key} placeholders`)
  }
  assert.equal(t('zipArchiving', { index: 2, count: 5, name: 'a.txt' }), 'File 2 of 5: a.txt')
  assert.equal(t('vaultZipExportConfirm'), 'Save unencrypted ZIP')
  assert.match(t('vaultZipExportBody', { count: 4, size: '1 MB' }), /not.*encrypted/i)
  assert.match(t('xferReasonLocalDiskFull'), /this device/)
  assert.doesNotMatch(t('xferReasonLocalDiskFull'), /Data Lake/)
})

const render = (transfer) => renderToStaticMarkup(React.createElement(VaultTransferPanel, { t, transfer, onCancel() {}, onDismiss() {} }))
const base = { kind: 'download', index: 2, count: 5, name: 'b.txt', transferredBytes: 10, totalBytes: 100, percent: 10, rate: null }
const hasCancel = (html) => html.includes(`>${t('vaultXferCancel')}<`)
const hasRateRow = (html) => html.includes('data-vault-transfer-rate')

test('ZPANEL-1 preparing: archive label, Cancel available, rate row reserved', () => {
  const html = render({ ...base, stage: 'preparing' })
  assert.ok(html.includes(t('zipPreparing')))
  assert.ok(!html.includes(t('vaultXferFailed')))
  assert.ok(hasCancel(html))
  assert.ok(hasRateRow(html))
})

test('ZPANEL-2 archiving: "File i of N: name", rate row measured, Cancel available', () => {
  const html = render({ ...base, stage: 'archiving' })
  assert.ok(html.includes(t('zipArchiving', { index: 2, count: 5, name: 'b.txt' })))
  assert.ok(hasRateRow(html))
  assert.ok(hasCancel(html))
  assert.ok(html.includes('data-vault-transfer-stage="archiving"'))
})

test('ZPANEL-3 finalizing: label shown, no rate row, Cancel NOT rendered', () => {
  const html = render({ ...base, stage: 'finalizing', percent: 99.9 })
  assert.ok(html.includes(t('zipFinalizing')))
  assert.ok(!hasRateRow(html))
  assert.ok(!hasCancel(html))
})

test('ZPANEL-4 localDiskFull and finalizeFailed render the local-disk keys and the failed entry; never noSpace', () => {
  for (const [reason, key] of [['localDiskFull', 'xferReasonLocalDiskFull'], ['finalizeFailed', 'xferReasonFinalizeFailed']]) {
    const html = render({ ...base, stage: 'failed', reason, failedName: 'c.txt' })
    assert.ok(html.includes(t(key).replaceAll("'", '&#x27;')), reason)
    assert.ok(!html.includes(t('vaultXferReasonNoSpace')), reason)
    assert.ok(html.includes(t('zipFailedEntry', { name: 'c.txt' })), reason)
    assert.ok(html.includes(`>${t('vaultXferDismiss')}<`))
  }
})

test('ZPANEL-5 existing stages are unchanged', () => {
  const dl = render({ kind: 'download', stage: 'downloading', chunkIndex: 0, chunkCount: 3, transferredBytes: 1, totalBytes: 3, percent: 33 })
  assert.ok(dl.includes(t('vaultXferDownloading', { index: 1, count: 3 })))
  assert.ok(hasCancel(dl))
  const up = render({ kind: 'upload', stage: 'preparing', transferredBytes: 0, totalBytes: 3, percent: 0 })
  assert.ok(up.includes(t('vaultXferPreparing')))
  const noSpace = render({ kind: 'upload', stage: 'failed', reason: 'noSpace', transferredBytes: 0, totalBytes: 3, percent: 0 })
  assert.ok(noSpace.includes(t('vaultXferReasonNoSpace')))
})
