// tests/previewIndexOldClientCompat.test.js — AEGIS Drive (IDEA1) · D-1 PR-E Task I.1 · baseline client after index creation (memory)
//
// Needs D1_BASELINE_ROOT = IDEA1-AEGIS_Drive_LC of a detached `2dc596d1` worktree (node_modules junctioned); without it
// every test is skipped with an explicit reason — an evidence run must show 0 skips. PostgreSQL twin:
// tests/previewIndexOldClientCompatPostgres.test.js.
import test, { before, after } from 'node:test'
import * as H from './helpers/previewIndexUploadHarness.mjs'
import { definePreviewIndexOldClientSpec, oldClientServerConfig } from './helpers/previewIndexOldClientSpec.mjs'
import { APPROVED_BUDGET_BYTES } from './helpers/previewIndexSecurityGateSpec.mjs'

before(async () => { await H.setup({ write: oldClientServerConfig(H, APPROVED_BUDGET_BYTES) }); await H.reset() })
after(() => H.teardown())

definePreviewIndexOldClientSpec({ test, H })
