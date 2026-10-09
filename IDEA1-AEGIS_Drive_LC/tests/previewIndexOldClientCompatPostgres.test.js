// tests/previewIndexOldClientCompatPostgres.test.js — AEGIS Drive (IDEA1) · D-1 PR-E Task I.1 · baseline client on PostgreSQL 15
//
// Same spec as tests/previewIndexOldClientCompat.test.js on a fresh database cloned from TEMPLATE aegis_drive_test
// (drive_app, non-superuser). Needs TEST_DATABASE_URL and D1_BASELINE_ROOT; otherwise skipped with an explicit reason —
// an evidence run must show 0 skips.
import test, { before, after } from 'node:test'

const pgSkip = process.env.TEST_DATABASE_URL ? false : 'needs TEST_DATABASE_URL (scripts/pg-integration-env.sh) to run against PostgreSQL 15'
if (!pgSkip) process.env.PI_UPLOAD_PG = '1'
const H = pgSkip ? null : await import('./helpers/previewIndexUploadHarness.mjs')
const { definePreviewIndexOldClientSpec, oldClientServerConfig } = await import('./helpers/previewIndexOldClientSpec.mjs')
const { APPROVED_BUDGET_BYTES } = await import('./helpers/previewIndexSecurityGateSpec.mjs')

before(async () => { if (!pgSkip) { await H.setup({ write: oldClientServerConfig(H, APPROVED_BUDGET_BYTES) }); await H.reset() } })
after(async () => { if (!pgSkip) await H.teardown() })

definePreviewIndexOldClientSpec({ test, H: H ?? {}, skip: pgSkip })
