// tests/previewIndexStore.test.js — AEGIS Drive (IDEA1) · D-1 PR-A Task A.3 · preview-index read/accounting store (memory mode)
//
// The same spec runs on PostgreSQL 15 in tests/previewIndexStorePostgres.test.js.
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-preview-index-store-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
delete process.env.DATABASE_URL

const store = await import('../server/db/vaultPreviewIndexStore.js')
const tree = await import('../server/db/vaultTreeStore.js')
const v2 = await import('../server/db/vaultV2Store.js')
const { definePreviewIndexStoreSpec } = await import('./helpers/previewIndexStoreSpec.mjs')

let n = 1000
definePreviewIndexStoreSpec({ test, store, tree, v2, newOwner: async () => String(++n) })

test.after(async () => { await fs.rm(STORAGE_ROOT, { recursive: true, force: true }) })
