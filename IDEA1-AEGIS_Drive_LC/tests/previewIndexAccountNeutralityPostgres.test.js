// tests/previewIndexAccountNeutralityPostgres.test.js — AEGIS Drive (IDEA1) · D-1 PR-E Task H.2 · account neutrality on PostgreSQL 15
//
// The same spec as tests/previewIndexAccountNeutrality.test.js against a fresh database cloned from TEMPLATE
// aegis_drive_test (drive_app, non-superuser). Without TEST_DATABASE_URL every test is skipped with an explicit reason —
// an evidence run must show 0 skips.
import test, { before, after } from 'node:test'

const skip = process.env.TEST_DATABASE_URL ? false : 'needs TEST_DATABASE_URL (scripts/pg-integration-env.sh) to run against PostgreSQL 15'
if (!skip) process.env.PI_UPLOAD_PG = '1'
const H = skip ? null : await import('./helpers/previewIndexUploadHarness.mjs')
const { definePreviewIndexNeutralitySpec } = await import('./helpers/previewIndexNeutralitySpec.mjs')
const { APPROVED_BUDGET_BYTES } = await import('./helpers/previewIndexSecurityGateSpec.mjs')

before(async () => { if (!skip) { await H.setup({ write: H.cfg.write(APPROVED_BUDGET_BYTES), small: H.cfg.write(H.MiB) }); await H.reset() } })
after(async () => { if (!skip) await H.teardown() })

definePreviewIndexNeutralitySpec({ test, H: H ?? {}, skip })
