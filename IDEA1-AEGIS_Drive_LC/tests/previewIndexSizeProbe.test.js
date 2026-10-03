import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getInventoryWithRetry } from '../scripts/measure/vault-preview-index-e2e.mjs'

test('PIS-G1 inventory retries one failed idempotent local read and records attempts', async () => {
  let attempts = 0
  const response = await getInventoryWithRetry({ req: async () => {
    attempts++
    if (attempts === 1) throw Object.assign(new Error('read reset'), { code: 'ECONNRESET' })
    return { status: 200, data: { configured: true, blobs: [] } }
  } })
  assert.equal(response.attempts, 2)
  assert.equal(response.result.status, 200)
})

test('PIS-1 codec probe models six non-file nodes and measures unchanged main bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-pis-'))
  try {
    const out = join(dir, 'probe.json')
    const run = spawnSync(process.execPath, ['scripts/measure/vault-preview-index-size.mjs', '--mode', 'codec', '--nodes', '10', '--variants', '2', '--runs', '20', '--out', out], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30_000 })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(result.label, 'CODEC_ONLY_PRELIMINARY')
    assert.equal(result.mainManifest[0].files, 4)
    assert.equal(result.mainManifest[0].nonFileNodes, 6)
    assert.equal(result.mainManifest[0].deltaBytes, 0)
    assert.equal(result.mainManifest[0].canonicalBytesEqual, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PIS-G1 e2e memory probe reports measured matrix groups and an unchanged manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-pis-e2e-'))
  try {
    const out = join(dir, 'e2e.json')
    const run = spawnSync(process.execPath, [
      'scripts/measure/vault-preview-index-size.mjs', '--mode', 'e2e', '--nodes', '10',
      '--variants', '2', '--runs', '20', '--server', 'memory', '--out', out,
    ], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 120_000 })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(result.label, 'IDX_SIZE_EVIDENCE')
    assert.equal(result.cells.length, 1)
    assert.equal(result.cells[0].runs, 20)
    assert.equal(result.cells[0].mainManifest.deltaBytes, 0)
    assert.equal(result.cells[0].mainManifest.unit, 'B')
    assert.equal(result.cells[0].nodeTimings.rootEncode.unit, 'ms')
    for (const group of ['root', 'shards', 'storage', 'retainedBudget', 'coldTiles', 'nodeTimings', 'serverTimings', 'mutationTimings', 'audit']) {
      assert.ok(result.cells[0][group], `${group} must not be omitted`)
    }
    for (const input of ['A', 'B', 'C', 'D']) {
      assert.ok(Number.isSafeInteger(result.cells[0].retainedBudget[input].bytes), `${input} must be measured in bytes`)
    }
    assert.equal(result.cells[0].retainedBudget.B.writerSessions, 1)
    assert.ok(Number.isSafeInteger(result.cells[0].storage.currentGenerationFinalCipherBytes))
    assert.ok(Number.isSafeInteger(result.cells[0].storage.supersededAfterChurnCipherBytes))
    assert.equal(result.cells[0].storage.casLossStagedCipherBytes,
      result.cells[0].retainedBudget.D.bytes - result.cells[0].retainedBudget.C.bytes)
    assert.equal(result.cells[0].mutationTimings.singleEntry.runs, 20)
    assert.equal(result.cells[0].mutationTimings.fullBatch.runs, 20)
    assert.ok(Number.isSafeInteger(result.cells[0].audit.batchWriteRows))
    assert.equal(result.cells[0].retainedBudget.candidateBudgets.length, 6)
    assert.equal(result.cells[0].serverTimings.rootUpload.runs >= 20, true)
    assert.equal(result.cells[0].serverTimings.shardUpload.runs >= 20, true)
    assert.equal(result.cells[0].coldTiles.requestDistribution.runs, 20)
    assert.equal(result.cells[0].coldTiles.latency.runs, 20)
    assert.equal(result.cells[0].coldTiles.auditDistribution.runs, 20)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PIS-G1 Chrome mode measures real browser crypto timings with exclusive output', () => {
  const browser = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  if (process.platform !== 'win32') return
  const dir = mkdtempSync(join(tmpdir(), 'aegis-pis-chrome-'))
  try {
    const out = join(dir, 'chrome.json')
    const args = ['scripts/measure/vault-preview-index-size.mjs', '--mode', 'e2e', '--nodes', '10',
      '--variants', '2', '--runs', '20', '--browser', browser, '--out', out]
    const run = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 120_000 })
    assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(result.cells[0].chromeTimings.shardEncode.runs, 20)
    assert.equal(result.cells[0].mainManifest.deltaBytes, 0)
    const second = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 120_000 })
    assert.notEqual(second.status, 0, 'existing raw evidence must not be overwritten')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PIS-G1 PostgreSQL mode rejects a non-local superuser URL before creating evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-pis-pg-guard-'))
  try {
    const out = join(dir, 'must-not-exist.json')
    const run = spawnSync(process.execPath, ['scripts/measure/vault-preview-index-size.mjs', '--mode', 'e2e',
      '--nodes', '10', '--variants', '2', '--runs', '20', '--server', 'pg', '--out', out], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, D1_IDX_SIZE_PG_CONFIRMED: '1',
        TEST_DATABASE_URL: 'postgresql://drive_app:local-only@127.0.0.1:55750/aegis_drive_test',
        AEGIS_PGTEST_SUPER_URL: 'postgresql://lftv2_admin:forbidden@example.com:55750/postgres' },
    })
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /refuses a superuser URL/)
    assert.throws(() => readFileSync(out))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
