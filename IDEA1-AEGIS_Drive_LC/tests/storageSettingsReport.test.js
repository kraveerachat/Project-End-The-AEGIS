// tests/storageSettingsReport.test.js — truthful Storage & Data settings facts
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildStorageReport } from '../server/storage/storageReport.js'

const diskHealth = async () => ({ available: false, status: 'UNKNOWN', reason: 'agent-unreachable' })
const backup = async () => ({ available: false, state: 'UNKNOWN', risk: 'UNKNOWN', reason: 'agent-unreachable' })

test('STORAGE-SETTINGS-1 report exposes the configured root and upload-usable capacity from the enforced reserve rule', async () => {
  const report = await buildStorageReport({
    storageStatus: async () => ({
      capacityBytes: { totalBytes: 1000, usedBytes: 400, freeBytes: 600 },
      usage: {},
      unaccountedBytes: 400,
    }),
    diskHealth,
    backup,
    storageRoot: '/srv/aegis/datalake',
    reserveFor: () => 125,
  })

  assert.deepEqual(report.storage, {
    root: '/srv/aegis/datalake',
    reserveBytes: 125,
    usableBytes: 475,
  })
})

test('STORAGE-SETTINGS-2 unreadable capacity never fabricates reserve or usable bytes', async () => {
  const report = await buildStorageReport({
    storageStatus: async () => ({ capacityBytes: null, usage: {}, unaccountedBytes: null }),
    diskHealth,
    backup,
    storageRoot: '/srv/aegis/datalake',
    reserveFor: () => { throw new Error('must not run without a measured denominator') },
  })

  assert.deepEqual(report.storage, {
    root: '/srv/aegis/datalake',
    reserveBytes: null,
    usableBytes: null,
  })
})
