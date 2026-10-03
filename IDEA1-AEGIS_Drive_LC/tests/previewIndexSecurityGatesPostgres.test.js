// tests/previewIndexSecurityGatesPostgres.test.js — AEGIS Drive (IDEA1) · D-1 PR-E Task H.1 · server security gates on PostgreSQL 15
//
// The same spec as tests/previewIndexSecurityGates.test.js, against a fresh database cloned from TEMPLATE aegis_drive_test
// (drive_app, non-superuser). SG-SUP-2 additionally captures every SQL statement and proves no DELETE / TRUNCATE / DROP
// reaches the blob, lifecycle or preview-index tables.
// Without TEST_DATABASE_URL every test is skipped with an explicit reason — an evidence run must show 0 skips.
import test, { before, after, beforeEach } from 'node:test'

const skip = process.env.TEST_DATABASE_URL ? false : 'needs TEST_DATABASE_URL (scripts/pg-integration-env.sh) to run against PostgreSQL 15'
if (!skip) process.env.PI_UPLOAD_PG = '1'
const H = skip ? null : await import('./helpers/previewIndexUploadHarness.mjs')
const { definePreviewIndexSecurityGateSpec, APPROVED_BUDGET_BYTES } = await import('./helpers/previewIndexSecurityGateSpec.mjs')

before(async () => {
  if (skip) return
  const { cfg, MiB } = H
  await H.setup({ off: cfg.off(), read: cfg.read(), write: cfg.write(APPROVED_BUDGET_BYTES), small: cfg.write(MiB) })
})
after(async () => { if (!skip) await H.teardown() })
beforeEach(async () => { if (!skip) await H.reset() })

definePreviewIndexSecurityGateSpec({ test, H: H ?? {}, skip })
