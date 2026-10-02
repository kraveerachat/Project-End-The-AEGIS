import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
