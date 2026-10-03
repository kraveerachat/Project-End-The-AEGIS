// tests/previewIndexAuditVolumeProbe.test.js — AEGIS Drive (IDEA1) · D-1 PR-E Task H.3 · audit-volume probe guards
//
// The probe is measurement only. These tests pin its safety rails (local disposable targets, exclusive-create output,
// approved budget) and run one tiny memory measurement end to end with the privacy scan.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, APPROVED_BUDGET_BYTES } from '../scripts/measure/vault-preview-index-audit-volume.mjs'

const SCRIPT = 'scripts/measure/vault-preview-index-audit-volume.mjs'
const cwd = new URL('..', import.meta.url)
const LOCAL = { TEST_DATABASE_URL: 'postgresql://drive_app:local-only@127.0.0.1:55750/aegis_drive_test', AEGIS_PGTEST_SUPER_URL: 'postgresql://lftv2_admin:local-only@127.0.0.1:55750/postgres' }

test('PIAV-1 argument guards: server, out, runs >= 20, node range; PostgreSQL only with explicit confirmation and the local disposable harness', () => {
  assert.throws(() => parseArgs(['--out', 'x.json']), /--server must be memory or pg/)
  assert.throws(() => parseArgs(['--server', 'memory']), /--out is required/)
  assert.throws(() => parseArgs(['--server', 'memory', '--out', 'x', '--runs', '5']), /--runs must be >= 20/)
  assert.throws(() => parseArgs(['--server', 'memory', '--out', 'x', '--nodes', '20000']), /--nodes/)
  assert.throws(() => parseArgs(['--server', 'pg', '--out', 'x'], LOCAL), /D1_IDX_AUDIT_PG_CONFIRMED=1/)
  assert.throws(() => parseArgs(['--server', 'pg', '--out', 'x'], { ...LOCAL, D1_IDX_AUDIT_PG_CONFIRMED: '1', TEST_DATABASE_URL: 'postgresql://drive_app:x@db.example.com:5432/aegis_drive' }), /outside the local disposable harness/)
  assert.throws(() => parseArgs(['--server', 'pg', '--out', 'x'], { ...LOCAL, D1_IDX_AUDIT_PG_CONFIRMED: '1', AEGIS_PGTEST_SUPER_URL: 'postgresql://postgres:x@127.0.0.1:5432/postgres' }), /superuser URL outside/)
  assert.equal(parseArgs(['--server', 'pg', '--out', 'x'], { ...LOCAL, D1_IDX_AUDIT_PG_CONFIRMED: '1' }).server, 'pg')
  assert.equal(APPROVED_BUDGET_BYTES, 8_589_934_592)
})

test('PIAV-2 tiny memory run: baseline / with-index / backfill phases, approved budget, zero privacy violations, exclusive output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-idx-audit-'))
  try {
    const out = join(dir, 'audit.json')
    const env = { ...process.env }; delete env.TEST_DATABASE_URL; delete env.DATABASE_URL
    const args = [SCRIPT, '--server', 'memory', '--nodes', '20', '--runs', '20', '--out', out]
    const run = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 300_000 })
    assert.equal(run.status, 0, run.stderr)
    const j = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(j.label, 'IDX_AUDIT_VOLUME'); assert.equal(j.status, 'MEASUREMENT_ONLY')
    assert.equal(j.approvedRetainedBudgetBytes, APPROVED_BUDGET_BYTES)
    assert.equal(j.visibleTiles, 14)
    assert.deepEqual(Object.keys(j.phases).sort(), ['backfill', 'baseline', 'withIndex'])
    for (const phase of Object.values(j.phases)) assert.equal(phase.runs, 20)
    assert.equal(j.phases.baseline.byAction['VAULT_V2_READ/OK'].p50, 14, 'baseline: one chunk-0 read per visible original')
    assert.ok(j.phases.withIndex.byAction['VAULT_V2_READ/OK'].p50 > 14, 'with index: derivative + index object reads')
    assert.equal(j.phases.backfill.byAction['VAULT_PREVIEW_INDEX_CAS/OK'].p50, 1, 'one CAS per backfill batch')
    assert.deepEqual(j.privacy.violations, []); assert.ok(j.privacy.rowsScanned > 0)
    const again = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 60_000 })
    assert.notEqual(again.status, 0, 'existing evidence is never overwritten')
    assert.match(again.stderr, /already exists/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
