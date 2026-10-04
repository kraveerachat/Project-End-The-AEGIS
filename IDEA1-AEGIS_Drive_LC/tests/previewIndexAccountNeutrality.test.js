// tests/previewIndexAccountNeutrality.test.js — AEGIS Drive (IDEA1) · D-1 PR-E Task H.2 · preview-index account neutrality (memory)
//
// ADMIN / EXISTING_USER / NEWLY_CREATED_USER behave identically for their own preview index; no Admin override; no
// cross-owner de-duplication; per-owner budget. The same spec runs on PostgreSQL 15 in
// tests/previewIndexAccountNeutralityPostgres.test.js. (tests/previewAccountNeutrality.test.js keeps the P0 media-preview
// neutrality and adds the D-1 source scan; it boots its own app and cannot share this harness.)
import test, { before, after } from 'node:test'
import * as H from './helpers/previewIndexUploadHarness.mjs'
import { definePreviewIndexNeutralitySpec } from './helpers/previewIndexNeutralitySpec.mjs'
import { APPROVED_BUDGET_BYTES } from './helpers/previewIndexSecurityGateSpec.mjs'

before(async () => { await H.setup({ write: H.cfg.write(APPROVED_BUDGET_BYTES), small: H.cfg.write(H.MiB) }); await H.reset() })
after(() => H.teardown())

definePreviewIndexNeutralitySpec({ test, H })
